import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  GOLD_DATA_PROVIDER_IDS,
  SUPPORTED_CURRENCIES,
  SUPPORTED_UNITS,
  type GoldHistoryApiResponse,
} from '../shared/types.js';
import {
  executeMcpMarketAnalysis,
  searchGoldMarketNews,
} from './agent/marketAnalysisAgent.js';
import type { GoldPriceRepository } from './db/goldRepository.js';
import { McpKeyAndProviderService } from './mcp/mcpKeyServer.js';
import { ensureTwoYearDataSynced } from './services/goldDataSync.js';
import {
  QuerySanitizationError,
  sanitizeAiAnalyzeInput,
  sanitizeGoldHistoryQuery,
  sanitizeRawParam,
} from './validation/querySanitizer.js';

export interface CreateAppOptions {
  repository: GoldPriceRepository;
  referenceDateProvider?: () => Date;
}

export function createApiApp(options: CreateAppOptions): Express {
  const { repository, referenceDateProvider = () => new Date() } = options;
  const mcpService = new McpKeyAndProviderService(repository.getDatabase());

  // Per-IP sliding-window rate limiter for /api/ai/analyze (max 10 req/min)
  const aiRateLimitMap = new Map<string, number[]>();

  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));

  // Strict security & hygiene response headers
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; script-src 'self' 'unsafe-inline'; connect-src 'self'",
    );
    next();
  });

  // Health & window status endpoint
  app.get('/api/health', (_req: Request, res: Response) => {
    const now = referenceDateProvider();
    const bounds = ensureTwoYearDataSynced(repository, now);
    res.status(200).json({
      status: 'ok',
      window: bounds,
      timestamp: now.toISOString(),
    });
  });

  // ============================================================================
  // 1. Normalized Spot Gold Price Endpoint (/api/gold/spot) — 60s TTL Cache
  // ============================================================================
  app.get('/api/gold/spot', (req: Request, res: Response, next: NextFunction) => {
    try {
      const now = referenceDateProvider();
      ensureTwoYearDataSynced(repository, now);

      const rawCurrency = (
        sanitizeRawParam((req.query as Record<string, unknown>).currency, 'currency') ?? 'USD'
      ).toUpperCase();
      const rawUnit = (
        sanitizeRawParam((req.query as Record<string, unknown>).unit, 'unit') ?? 'oz'
      ).toLowerCase();

      const parsedCurrency = z.enum(SUPPORTED_CURRENCIES).safeParse(rawCurrency);
      const parsedUnit = z.enum(SUPPORTED_UNITS).safeParse(rawUnit);

      if (!parsedCurrency.success || !parsedUnit.success) {
        throw new QuerySanitizationError('Invalid currency or unit for /api/gold/spot.');
      }

      const spotQuote = repository.getSpotQuote(parsedCurrency.data, parsedUnit.data, now);
      res.status(200).json(spotQuote);
    } catch (err) {
      next(err);
    }
  });

  // ============================================================================
  // 2. 2-Year Historical Gold Price API (/api/gold/history) — 24h TTL Cache
  // ============================================================================
  app.get('/api/gold/history', (req: Request, res: Response, next: NextFunction) => {
    try {
      const now = referenceDateProvider();
      const twoYearBounds = ensureTwoYearDataSynced(repository, now);

      const sanitizedQuery = sanitizeGoldHistoryQuery(
        req.query as Record<string, unknown>,
        now,
      );

      const { summary, series } = repository.queryHistory(sanitizedQuery, twoYearBounds);

      const payload: GoldHistoryApiResponse = {
        meta: {
          range: sanitizedQuery.range,
          currency: sanitizedQuery.currency,
          unit: sanitizedQuery.unit,
          interval: sanitizedQuery.interval,
          startDate: sanitizedQuery.startDate,
          endDate: sanitizedQuery.endDate,
          sort: sanitizedQuery.sort,
          order: sanitizedQuery.order,
          count: series.length,
          isStale: false,
          cacheTtlSec: 86400,
          sanitizedQuery: {
            range: sanitizedQuery.range,
            startDate: sanitizedQuery.startDate,
            endDate: sanitizedQuery.endDate,
            currency: sanitizedQuery.currency,
            unit: sanitizedQuery.unit,
            interval: sanitizedQuery.interval,
            sort: sanitizedQuery.sort,
            order: sanitizedQuery.order,
            limit: String(sanitizedQuery.limit),
          },
          generatedAt: now.toISOString(),
        },
        summary,
        series,
      };

      res.status(200).json(payload);
    } catch (err) {
      next(err);
    }
  });

  // CSV export endpoint
  app.get('/api/gold/export.csv', (req: Request, res: Response, next: NextFunction) => {
    try {
      const now = referenceDateProvider();
      const twoYearBounds = ensureTwoYearDataSynced(repository, now);
      const sanitizedQuery = sanitizeGoldHistoryQuery(
        req.query as Record<string, unknown>,
        now,
      );

      const { series } = repository.queryHistory(sanitizedQuery, twoYearBounds);

      const header =
        'Date,Open,High,Low,Close,Change,ChangePercent,SMA20,SMA50,SMA200,Volume,Currency,Unit,Source';
      const lines = series.map((pt) =>
        [
          sanitizeCsvCell(pt.date),
          pt.open.toFixed(2),
          pt.high.toFixed(2),
          pt.low.toFixed(2),
          pt.close.toFixed(2),
          pt.change.toFixed(2),
          pt.changePercent.toFixed(2),
          pt.sma20 !== null ? pt.sma20.toFixed(2) : '',
          pt.sma50 !== null ? pt.sma50.toFixed(2) : '',
          pt.sma200 !== null ? pt.sma200.toFixed(2) : '',
          String(pt.volume),
          sanitizeCsvCell(sanitizedQuery.currency),
          sanitizeCsvCell(sanitizedQuery.unit),
          sanitizeCsvCell(pt.source),
        ].join(','),
      );

      const filename = `gold-price-${sanitizedQuery.currency.toLowerCase()}-${sanitizedQuery.unit}-${sanitizedQuery.startDate}-to-${sanitizedQuery.endDate}.csv`;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.status(200).send([header, ...lines].join('\n'));
    } catch (err) {
      next(err);
    }
  });

  // ============================================================================
  // 3. Grounded AI Market Analysis & Web News Search via MCP (/api/ai/analyze)
  // ============================================================================
  app.post('/api/ai/analyze', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const now = referenceDateProvider();
      const clientIp = req.ip ?? '127.0.0.1';
      const nowMs = now.getTime();
      const windowStartMs = nowMs - 60_000;
      const recentTimestamps = (aiRateLimitMap.get(clientIp) ?? []).filter(
        (ts) => ts > windowStartMs,
      );

      if (recentTimestamps.length >= 10) {
        throw new QuerySanitizationError(
          'Rate limit exceeded for /api/ai/analyze (max 10 requests per minute).',
          [],
          429,
        );
      }
      recentTimestamps.push(nowMs);
      aiRateLimitMap.set(clientIp, recentTimestamps);

      const { wrappedPrompt, cleanPrompt, currency } = sanitizeAiAnalyzeInput(req.body);
      const twoYearBounds = ensureTwoYearDataSynced(repository, now);
      const sanitizedQuery = sanitizeGoldHistoryQuery({ currency }, now);
      const { summary, series } = repository.queryHistory(sanitizedQuery, twoYearBounds);
      const spotQuote = repository.getSpotQuote(currency, 'oz', now);

      const configuredKeys = mcpService
        .listMcpAiKeys()
        .filter((k) => k.status === 'configured');

      const analysisResponse = await executeMcpMarketAnalysis({
        cleanPrompt,
        wrappedPrompt,
        currency,
        summary,
        series,
        spotQuote,
        activeMcpKey: configuredKeys[0] ?? null,
      });

      res.status(200).json(analysisResponse);
    } catch (err) {
      next(err);
    }
  });

  // ============================================================================
  // 4. Gold Data Providers API
  // ============================================================================
  app.get('/api/providers/gold', (_req: Request, res: Response, next: NextFunction) => {
    try {
      const providers = mcpService.listGoldProviders();
      res.status(200).json({
        providers,
        activePrimary: providers.find((p) => p.isPrimary)?.id ?? 'lbma-composite',
      });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/providers/gold/configure', (req: Request, res: Response, next: NextFunction) => {
    try {
      const updated = mcpService.configureGoldProvider(req.body);
      res.status(200).json({
        provider: updated,
        providers: mcpService.listGoldProviders(),
      });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/providers/gold/sync', (req: Request, res: Response, next: NextFunction) => {
    try {
      const now = referenceDateProvider();
      const rawProviderId =
        sanitizeRawParam((req.body as Record<string, unknown>)?.providerId, 'providerId') ??
        mcpService.listGoldProviders().find((p) => p.isPrimary)?.id ??
        'lbma-composite';

      const parsedId = z.enum(GOLD_DATA_PROVIDER_IDS).safeParse(rawProviderId);
      if (!parsedId.success) {
        throw new QuerySanitizationError(`Invalid Gold provider ID '${rawProviderId}'.`);
      }

      const bounds = ensureTwoYearDataSynced(repository, now);
      const syncedProvider = mcpService.markGoldProviderSynced(parsedId.data);

      res.status(200).json({
        status: 'synced',
        window: bounds,
        provider: syncedProvider,
      });
    } catch (err) {
      next(err);
    }
  });

  // ============================================================================
  // 5. AI API Keys & Gold Data Analysis Tools via MCP (/api/mcp, /api/mcp/rpc, /api/mcp/ai-keys)
  // ============================================================================
  app.get('/api/mcp/ai-keys', (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.status(200).json({
        protocol: 'MCP/2025-03-26',
        serverName: 'aurumtrack-mcp-key-vault',
        keys: mcpService.listMcpAiKeys(),
      });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/mcp/ai-keys', (req: Request, res: Response, next: NextFunction) => {
    try {
      const record = mcpService.upsertMcpAiKey(req.body);
      res.status(200).json({
        record,
        keys: mcpService.listMcpAiKeys(),
      });
    } catch (err) {
      next(err);
    }
  });

  app.delete('/api/mcp/ai-keys/:provider', (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = mcpService.deleteMcpAiKey(req.params.provider);
      res.status(200).json({
        ...result,
        keys: mcpService.listMcpAiKeys(),
      });
    } catch (err) {
      next(err);
    }
  });

  const handleMcpRequest = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const now = referenceDateProvider();
      const body = (req.body ?? {}) as Record<string, unknown>;

      if (body.method === 'tools/call' && body.params && typeof body.params === 'object') {
        const params = body.params as Record<string, unknown>;
        const toolName = sanitizeRawParam(params.name, 'name');
        const toolArgs = (params.arguments ?? {}) as Record<string, unknown>;

        if (toolName === 'get_gold_spot') {
          ensureTwoYearDataSynced(repository, now);
          const cur = (sanitizeRawParam(toolArgs.currency, 'currency') ?? 'USD').toUpperCase();
          const parsedCur = z.enum(SUPPORTED_CURRENCIES).safeParse(cur);
          if (!parsedCur.success) {
            throw new QuerySanitizationError(`Invalid currency '${cur}' in get_gold_spot.`);
          }
          const quote = repository.getSpotQuote(parsedCur.data, 'oz', now);
          res.status(200).json({
            jsonrpc: '2.0',
            id: (body.id as string | number | null) ?? null,
            result: {
              content: [{ type: 'text', text: JSON.stringify(quote) }],
            },
          });
          return;
        }

        if (toolName === 'get_gold_history') {
          const bounds = ensureTwoYearDataSynced(repository, now);
          const sanitizedQuery = sanitizeGoldHistoryQuery(toolArgs, now);
          const historyData = repository.queryHistory(sanitizedQuery, bounds);
          res.status(200).json({
            jsonrpc: '2.0',
            id: (body.id as string | number | null) ?? null,
            result: {
              content: [{ type: 'text', text: JSON.stringify(historyData.summary) }],
            },
          });
          return;
        }

        if (toolName === 'search_gold_market_news') {
          const bounds = ensureTwoYearDataSynced(repository, now);
          const q = sanitizeRawParam(toolArgs.query, 'query', 120) ?? 'gold central bank inflation';
          const cur = (sanitizeRawParam(toolArgs.currency, 'currency') ?? 'USD').toUpperCase();
          const sanitizedQuery = sanitizeGoldHistoryQuery({ currency: cur }, now);
          const { summary, series } = repository.queryHistory(sanitizedQuery, bounds);
          const newsResult = await searchGoldMarketNews(q, series, summary);
          res.status(200).json({
            jsonrpc: '2.0',
            id: (body.id as string | number | null) ?? null,
            result: {
              content: [{ type: 'text', text: JSON.stringify(newsResult) }],
            },
          });
          return;
        }

        if (toolName === 'analyze_gold_market_with_mcp') {
          const bounds = ensureTwoYearDataSynced(repository, now);
          const { wrappedPrompt, cleanPrompt, currency } = sanitizeAiAnalyzeInput(toolArgs);
          const sanitizedQuery = sanitizeGoldHistoryQuery({ currency }, now);
          const { summary, series } = repository.queryHistory(sanitizedQuery, bounds);
          const spotQuote = repository.getSpotQuote(currency, 'oz', now);
          const configuredKeys = mcpService
            .listMcpAiKeys()
            .filter((k) => k.status === 'configured');
          const report = await executeMcpMarketAnalysis({
            cleanPrompt,
            wrappedPrompt,
            currency,
            summary,
            series,
            spotQuote,
            activeMcpKey: configuredKeys[0] ?? null,
          });
          res.status(200).json({
            jsonrpc: '2.0',
            id: (body.id as string | number | null) ?? null,
            result: {
              content: [{ type: 'text', text: JSON.stringify(report) }],
            },
          });
          return;
        }
      }

      const rpcResponse = mcpService.handleMcpJsonRpc(req.body);
      res.status(200).json(rpcResponse);
    } catch (err) {
      next(err);
    }
  };

  app.post('/api/mcp', handleMcpRequest);
  app.post('/api/mcp/rpc', handleMcpRequest);

  // Centralized error handler that never leaks stack traces or internal SQL details
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof QuerySanitizationError) {
      res.status(err.statusCode).json({
        error: 'Bad Request — Query Hygiene Violation',
        message: err.message,
        details: err.details,
      });
      return;
    }

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'An unexpected error occurred while processing the request.',
    });
  });

  return app;
}

/**
 * Protects CSV exports from spreadsheet formula injection (CSV Injection)
 * and quotes strings containing commas or quotes.
 */
function sanitizeCsvCell(value: string): string {
  let safe = value;
  if (/^[=+\-@\t\r]/.test(safe)) {
    safe = `'${safe}`;
  }
  if (safe.includes(',') || safe.includes('"') || safe.includes('\n')) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}
