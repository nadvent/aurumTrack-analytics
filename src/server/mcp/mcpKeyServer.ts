import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  AI_KEY_PROVIDER_IDS,
  GOLD_DATA_PROVIDER_IDS,
  type AiKeyProviderId,
  type GoldDataProviderId,
  type GoldProviderInfo,
  type McpAiKeyRecord,
} from '../../shared/types.js';
import {
  QuerySanitizationError,
  assertAllowedUpstreamUrl,
  sanitizeRawParam,
} from '../validation/querySanitizer.js';

const AiKeyUpsertSchema = z.object({
  provider: z.enum(AI_KEY_PROVIDER_IDS),
  apiKey: z
    .string()
    .min(8, 'API key must be at least 8 characters')
    .max(256, 'API key must not exceed 256 characters')
    .regex(/^[A-Za-z0-9_\-.]+$/, 'API key contains invalid characters'),
  label: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9 _\-().]+$/, 'Label contains disallowed characters')
    .optional(),
});

const GoldProviderConfigSchema = z.object({
  providerId: z.enum(GOLD_DATA_PROVIDER_IDS),
  apiKey: z
    .string()
    .min(6)
    .max(256)
    .regex(/^[A-Za-z0-9_\-.]+$/, 'Provider API key contains invalid characters')
    .optional(),
  setPrimary: z.boolean().optional(),
  refreshIntervalSec: z.number().int().min(30).max(86400).optional(),
});

const McpJsonRpcSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.enum([
    'initialize',
    'resources/list',
    'resources/read',
    'tools/list',
    'tools/call',
  ]),
  params: z.record(z.unknown()).optional(),
});

const DEFAULT_GOLD_PROVIDERS: ReadonlyArray<{
  id: GoldDataProviderId;
  name: string;
  endpointUrl: string;
  isPrimary: number;
  refreshIntervalSec: number;
  reliabilityScore: number;
}> = [
  {
    id: 'lbma-composite',
    name: 'LBMA / XAU Spot Composite Feed',
    endpointUrl: 'https://prices.lbma.org.uk/json/gold_pm.json',
    isPrimary: 1,
    refreshIntervalSec: 300,
    reliabilityScore: 99.9,
  },
  {
    id: 'metals-api',
    name: 'Metals-API Real-Time Bullion',
    endpointUrl: 'https://metals-api.com/api/timeseries',
    isPrimary: 0,
    refreshIntervalSec: 600,
    reliabilityScore: 99.4,
  },
  {
    id: 'alpha-vantage',
    name: 'Alpha Vantage FX & Commodities (XAU)',
    endpointUrl: 'https://www.alphavantage.co/query?function=CURRENCY_EXCHANGE_RATE',
    isPrimary: 0,
    refreshIntervalSec: 900,
    reliabilityScore: 98.8,
  },
  {
    id: 'twelve-data',
    name: 'Twelve Data XAU/USD Time Series',
    endpointUrl: 'https://api.twelvedata.com/time_series?symbol=XAU/USD',
    isPrimary: 0,
    refreshIntervalSec: 300,
    reliabilityScore: 99.2,
  },
  {
    id: 'yahoo-finance-xau',
    name: 'Yahoo Finance Gold Futures & Spot (GC=F)',
    endpointUrl: 'https://query1.finance.yahoo.com/v8/finance/chart/GC=F',
    isPrimary: 0,
    refreshIntervalSec: 300,
    reliabilityScore: 98.5,
  },
];

const AI_PROVIDER_LABELS: Readonly<Record<AiKeyProviderId, string>> = {
  gemini: 'Google Gemini API (Design & ReAct Reasoning)',
  openai: 'OpenAI GPT-4o / o3 API',
  anthropic: 'Anthropic Claude Sonnet API',
  openrouter: 'OpenRouter Unified Gateway',
};

export class McpKeyAndProviderService {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.initTables();
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_ai_keys (
        provider TEXT PRIMARY KEY CHECK (provider IN ('gemini', 'openai', 'anthropic', 'openrouter')),
        label TEXT NOT NULL,
        masked_key TEXT NOT NULL,
        fingerprint_sha256 TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS gold_data_providers (
        id TEXT PRIMARY KEY CHECK (
          id IN ('lbma-composite', 'metals-api', 'alpha-vantage', 'twelve-data', 'yahoo-finance-xau')
        ),
        name TEXT NOT NULL,
        endpoint_url TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'standby', 'configured')),
        is_primary INTEGER NOT NULL CHECK (is_primary IN (0, 1)),
        masked_api_key TEXT,
        refresh_interval_sec INTEGER NOT NULL CHECK (refresh_interval_sec >= 30),
        last_synced_at TEXT NOT NULL,
        reliability_score REAL NOT NULL
      ) STRICT;
    `);

    const insertProvider = this.db.prepare(`
      INSERT OR IGNORE INTO gold_data_providers (
        id, name, endpoint_url, status, is_primary, masked_api_key, refresh_interval_sec, last_synced_at, reliability_score
      ) VALUES (
        $id, $name, $endpoint_url, $status, $is_primary, $masked_api_key, $refresh_interval_sec, $last_synced_at, $reliability_score
      )
    `);

    const nowIso = new Date().toISOString();
    for (const p of DEFAULT_GOLD_PROVIDERS) {
      insertProvider.run({
        $id: p.id,
        $name: p.name,
        $endpoint_url: p.endpointUrl,
        $status: p.isPrimary === 1 ? 'active' : 'standby',
        $is_primary: p.isPrimary,
        $masked_api_key: null,
        $refresh_interval_sec: p.refreshIntervalSec,
        $last_synced_at: nowIso,
        $reliability_score: p.reliabilityScore,
      });
    }
  }

  // ============================================================================
  // Gold Data Providers API Methods
  // ============================================================================

  public listGoldProviders(): GoldProviderInfo[] {
    const stmt = this.db.prepare(`
      SELECT id, name, endpoint_url, status, is_primary, masked_api_key,
             refresh_interval_sec, last_synced_at, reliability_score
      FROM gold_data_providers
      ORDER BY is_primary DESC, reliability_score DESC
    `);

    const rows = stmt.all() as Array<{
      id: GoldDataProviderId;
      name: string;
      endpoint_url: string;
      status: 'active' | 'standby' | 'configured';
      is_primary: number;
      masked_api_key: string | null;
      refresh_interval_sec: number;
      last_synced_at: string;
      reliability_score: number;
    }>;

    return rows.map((r) => {
      const parsedUrl = assertAllowedUpstreamUrl(r.endpoint_url);
      return {
        id: r.id,
        name: r.name,
        endpointUrl: r.endpoint_url,
        allowedDomain: parsedUrl.hostname,
        status: r.status,
        isPrimary: r.is_primary === 1,
        hasApiKey: r.masked_api_key !== null || r.id === 'lbma-composite',
        maskedApiKey: r.masked_api_key,
        refreshIntervalSec: r.refresh_interval_sec,
        lastSyncedAt: r.last_synced_at,
        reliabilityScore: r.reliability_score,
      };
    });
  }

  public configureGoldProvider(rawBody: unknown): GoldProviderInfo {
    const parsed = GoldProviderConfigSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new QuerySanitizationError(
        'Invalid Gold Data Provider configuration payload.',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      );
    }

    const { providerId, apiKey, setPrimary, refreshIntervalSec } = parsed.data;
    const nowIso = new Date().toISOString();

    this.db.exec('BEGIN IMMEDIATE TRANSACTION');
    try {
      if (setPrimary) {
        this.db
          .prepare(
            `UPDATE gold_data_providers SET is_primary = 0, status = CASE WHEN masked_api_key IS NOT NULL THEN 'configured' ELSE 'standby' END`,
          )
          .run();
      }

      const existing = this.db
        .prepare(
          'SELECT masked_api_key, refresh_interval_sec, is_primary, status FROM gold_data_providers WHERE id = $id',
        )
        .get({ $id: providerId }) as
        | {
            masked_api_key: string | null;
            refresh_interval_sec: number;
            is_primary: number;
            status: string;
          }
        | undefined;

      if (!existing) {
        throw new QuerySanitizationError(`Gold provider '${providerId}' not found.`);
      }

      const newMaskedKey = apiKey ? maskSecretKey(apiKey) : existing.masked_api_key;
      const newPrimary = setPrimary !== undefined ? (setPrimary ? 1 : 0) : existing.is_primary;
      const newStatus =
        newPrimary === 1 ? 'active' : newMaskedKey ? 'configured' : 'standby';
      const newInterval = refreshIntervalSec ?? existing.refresh_interval_sec;

      this.db
        .prepare(`
          UPDATE gold_data_providers
          SET masked_api_key = $masked_api_key,
              is_primary = $is_primary,
              status = $status,
              refresh_interval_sec = $refresh_interval_sec,
              last_synced_at = $last_synced_at
          WHERE id = $id
        `)
        .run({
          $id: providerId,
          $masked_api_key: newMaskedKey,
          $is_primary: newPrimary,
          $status: newStatus,
          $refresh_interval_sec: newInterval,
          $last_synced_at: nowIso,
        });

      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    const updated = this.listGoldProviders().find((p) => p.id === providerId);
    if (!updated) {
      throw new QuerySanitizationError(`Unable to load updated provider '${providerId}'.`);
    }
    return updated;
  }

  public markGoldProviderSynced(providerId: GoldDataProviderId): GoldProviderInfo {
    const parsedId = z.enum(GOLD_DATA_PROVIDER_IDS).safeParse(providerId);
    if (!parsedId.success) {
      throw new QuerySanitizationError('Invalid Gold provider ID.');
    }

    const nowIso = new Date().toISOString();
    this.db
      .prepare('UPDATE gold_data_providers SET last_synced_at = $now WHERE id = $id')
      .run({ $now: nowIso, $id: parsedId.data });

    const found = this.listGoldProviders().find((p) => p.id === parsedId.data);
    if (!found) {
      throw new QuerySanitizationError('Gold provider not found.');
    }
    return found;
  }

  // ============================================================================
  // MCP AI API Key Vault Methods (REST + JSON-RPC 2.0 MCP Protocol)
  // ============================================================================

  public listMcpAiKeys(): McpAiKeyRecord[] {
    const stmt = this.db.prepare(
      'SELECT provider, label, masked_key, fingerprint_sha256, updated_at FROM mcp_ai_keys',
    );
    const rows = stmt.all() as Array<{
      provider: AiKeyProviderId;
      label: string;
      masked_key: string;
      fingerprint_sha256: string;
      updated_at: string;
    }>;

    const byProvider = new Map(rows.map((r) => [r.provider, r]));

    return AI_KEY_PROVIDER_IDS.map((provider) => {
      const stored = byProvider.get(provider);
      if (stored) {
        return {
          provider,
          label: stored.label,
          maskedKey: stored.masked_key,
          fingerprintSha256: stored.fingerprint_sha256,
          mcpResourceUri: `mcp://aurumtrack/ai-keys/${provider}`,
          status: 'configured',
          updatedAt: stored.updated_at,
        };
      }
      return {
        provider,
        label: AI_PROVIDER_LABELS[provider],
        maskedKey: 'Not configured',
        fingerprintSha256: '—',
        mcpResourceUri: `mcp://aurumtrack/ai-keys/${provider}`,
        status: 'missing',
        updatedAt: '—',
      };
    });
  }

  public upsertMcpAiKey(rawInput: unknown): McpAiKeyRecord {
    const parsed = AiKeyUpsertSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new QuerySanitizationError(
        'Invalid MCP AI API Key payload.',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      );
    }

    const { provider, apiKey, label } = parsed.data;
    const maskedKey = maskSecretKey(apiKey);
    const fingerprint = crypto
      .createHash('sha256')
      .update(apiKey)
      .digest('hex')
      .slice(0, 16);
    const nowIso = new Date().toISOString();
    const finalLabel = label ?? AI_PROVIDER_LABELS[provider];

    const stmt = this.db.prepare(`
      INSERT INTO mcp_ai_keys (provider, label, masked_key, fingerprint_sha256, updated_at)
      VALUES ($provider, $label, $masked_key, $fingerprint, $updated_at)
      ON CONFLICT(provider) DO UPDATE SET
        label = excluded.label,
        masked_key = excluded.masked_key,
        fingerprint_sha256 = excluded.fingerprint_sha256,
        updated_at = excluded.updated_at
    `);

    stmt.run({
      $provider: provider,
      $label: finalLabel,
      $masked_key: maskedKey,
      $fingerprint: fingerprint,
      $updated_at: nowIso,
    });

    return {
      provider,
      label: finalLabel,
      maskedKey,
      fingerprintSha256: fingerprint,
      mcpResourceUri: `mcp://aurumtrack/ai-keys/${provider}`,
      status: 'configured',
      updatedAt: nowIso,
    };
  }

  public deleteMcpAiKey(rawProvider: unknown): { deleted: boolean; provider: AiKeyProviderId } {
    const clean = sanitizeRawParam(rawProvider, 'provider')?.toLowerCase();
    const parsed = z.enum(AI_KEY_PROVIDER_IDS).safeParse(clean);
    if (!parsed.success) {
      throw new QuerySanitizationError(`Invalid AI key provider '${String(rawProvider)}'.`);
    }

    const stmt = this.db.prepare('DELETE FROM mcp_ai_keys WHERE provider = $provider');
    const res = stmt.run({ $provider: parsed.data });
    return { deleted: Number(res.changes) > 0, provider: parsed.data };
  }

  /**
   * Handles Model Context Protocol (MCP) JSON-RPC 2.0 requests (`resources/list`,
   * `resources/read`, `tools/list`, `tools/call`) for AI API keys & Gold Providers.
   */
  public handleMcpJsonRpc(rawPayload: unknown): {
    jsonrpc: '2.0';
    id: string | number | null;
    result: unknown;
  } {
    const parsed = McpJsonRpcSchema.safeParse(rawPayload);
    if (!parsed.success) {
      throw new QuerySanitizationError(
        'Invalid MCP JSON-RPC 2.0 request.',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      );
    }

    const { id = null, method, params = {} } = parsed.data;

    switch (method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2025-03-26',
            serverInfo: {
              name: 'aurumtrack-mcp-key-vault',
              version: '1.0.0',
            },
            capabilities: {
              resources: { listChanged: true },
              tools: { listChanged: false },
            },
          },
        };

      case 'resources/list': {
        const keys = this.listMcpAiKeys();
        return {
          jsonrpc: '2.0',
          id,
          result: {
            resources: keys.map((k) => ({
              uri: k.mcpResourceUri,
              name: `${k.provider.toUpperCase()} AI Key Metadata`,
              description: `${k.label} (Status: ${k.status}, Masked: ${k.maskedKey})`,
              mimeType: 'application/json',
            })),
          },
        };
      }

      case 'resources/read': {
        const uri = sanitizeRawParam(params.uri, 'uri') ?? '';
        const match = /^mcp:\/\/aurumtrack\/ai-keys\/(gemini|openai|anthropic|openrouter)$/.exec(
          uri,
        );
        if (!match) {
          throw new QuerySanitizationError(`Unsupported MCP resource URI '${uri}'.`);
        }
        const provider = match[1] as AiKeyProviderId;
        const record = this.listMcpAiKeys().find((k) => k.provider === provider);
        return {
          jsonrpc: '2.0',
          id,
          result: {
            contents: [
              {
                uri,
                mimeType: 'application/json',
                text: JSON.stringify(record),
              },
            ],
          },
        };
      }

      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            tools: [
              {
                name: 'mcp_register_ai_key',
                description:
                  'Registers or rotates an AI provider API key inside the MCP Vault with SHA-256 fingerprinting',
                inputSchema: {
                  type: 'object',
                  properties: {
                    provider: { type: 'string', enum: AI_KEY_PROVIDER_IDS },
                    apiKey: { type: 'string' },
                    label: { type: 'string' },
                  },
                  required: ['provider', 'apiKey'],
                },
              },
              {
                name: 'mcp_verify_ai_key_status',
                description: 'Checks whether an AI provider API key is configured in the MCP Vault',
                inputSchema: {
                  type: 'object',
                  properties: {
                    provider: { type: 'string', enum: AI_KEY_PROVIDER_IDS },
                  },
                  required: ['provider'],
                },
              },
              {
                name: 'get_gold_spot',
                description: 'Returns normalized spot gold price (XAU) from the 60s TTL cache',
                inputSchema: {
                  type: 'object',
                  properties: {
                    currency: { type: 'string', enum: ['USD', 'EUR', 'GBP', 'MYR', 'SGD'] },
                  },
                },
              },
              {
                name: 'get_gold_history',
                description: 'Returns 2-year historical gold prices and summary metrics',
                inputSchema: {
                  type: 'object',
                  properties: {
                    range: { type: 'string', enum: ['1M', '3M', '6M', '1Y', '2Y'] },
                    currency: { type: 'string', enum: ['USD', 'EUR', 'GBP', 'MYR', 'SGD'] },
                  },
                },
              },
              {
                name: 'search_gold_market_news',
                description:
                  'Searches the web and 2-year macro event index for major gold market news, central bank policy, and geopolitical catalysts',
                inputSchema: {
                  type: 'object',
                  properties: {
                    query: { type: 'string' },
                    currency: { type: 'string', enum: ['USD', 'EUR', 'GBP', 'MYR', 'SGD'] },
                  },
                },
              },
              {
                name: 'analyze_gold_market_with_mcp',
                description:
                  'Runs full MCP + ReAct data analysis combining 2-year gold price statistics, moving averages, and web news event correlation',
                inputSchema: {
                  type: 'object',
                  properties: {
                    prompt: { type: 'string' },
                    currency: { type: 'string', enum: ['USD', 'EUR', 'GBP', 'MYR', 'SGD'] },
                  },
                  required: ['prompt'],
                },
              },
            ],
          },
        };

      case 'tools/call': {
        const toolName = sanitizeRawParam(params.name, 'name');
        const toolArgs = (params.arguments ?? {}) as Record<string, unknown>;

        if (toolName === 'mcp_register_ai_key') {
          const saved = this.upsertMcpAiKey(toolArgs);
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(saved) }],
            },
          };
        }

        if (toolName === 'mcp_verify_ai_key_status') {
          const prov = sanitizeRawParam(toolArgs.provider, 'provider')?.toLowerCase();
          const found = this.listMcpAiKeys().find((k) => k.provider === prov);
          if (!found) {
            throw new QuerySanitizationError(`Unknown AI provider '${String(prov)}'.`);
          }
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(found) }],
            },
          };
        }

        throw new QuerySanitizationError(`Unknown MCP tool '${String(toolName)}'.`);
      }
    }
  }
}

function maskSecretKey(rawKey: string): string {
  const trimmed = rawKey.trim();
  if (trimmed.length <= 8) {
    return `${trimmed.slice(0, 2)}••••${trimmed.slice(-2)}`;
  }
  return `${trimmed.slice(0, 4)}••••••••${trimmed.slice(-4)}`;
}
