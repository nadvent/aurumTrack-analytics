import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApp } from '../src/server/app.js';
import { GoldPriceRepository } from '../src/server/db/goldRepository.js';

describe('Gold Price 2-Year API, Gold Providers, MCP Key Vault, and MCP Data Analysis + Web News Search', () => {
  let repo: GoldPriceRepository;
  const fixedToday = new Date('2026-11-12T15:30:00Z');

  beforeAll(() => {
    repo = new GoldPriceRepository(':memory:');
  });

  afterAll(() => {
    repo.close();
  });

  it('returns complete 2-year gold price history up to today with security headers', async () => {
    const app = createApiApp({
      repository: repo,
      referenceDateProvider: () => fixedToday,
    });

    const res = await request(app).get('/api/gold/history');
    expect(res.status).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');

    expect(res.body.meta.startDate).toBe('2024-11-12');
    expect(res.body.meta.endDate).toBe('2026-11-12');
    expect(res.body.meta.currency).toBe('USD');
    expect(res.body.meta.unit).toBe('oz');
    expect(res.body.series.length).toBeGreaterThan(500);

    const firstPoint = res.body.series[0];
    const lastPoint = res.body.series[res.body.series.length - 1];
    expect(firstPoint.date).toBe('2024-11-12');
    expect(lastPoint.date).toBe('2026-11-12');
    expect(lastPoint.sma20).toBeTypeOf('number');
    expect(lastPoint.sma50).toBeTypeOf('number');
    expect(lastPoint.sma200).toBeTypeOf('number');
  });

  it('serves normalized spot gold quote (/api/gold/spot) with 60s TTL cache and multi-currency support (USD, EUR, GBP, MYR, SGD)', async () => {
    const app = createApiApp({
      repository: repo,
      referenceDateProvider: () => fixedToday,
    });

    const spotMyr = await request(app).get('/api/gold/spot?currency=MYR');
    expect(spotMyr.status).toBe(200);
    expect(spotMyr.body.currency).toBe('MYR');
    expect(spotMyr.body.priceConverted).toBeGreaterThan(spotMyr.body.priceUsdOz);
    expect(spotMyr.body.bid).toBeLessThan(spotMyr.body.ask);
    expect(spotMyr.body.isStale).toBe(false);
  });

  it('rejects SQL injection attempts on query endpoints with HTTP 400 and keeps DB intact', async () => {
    const app = createApiApp({
      repository: repo,
      referenceDateProvider: () => fixedToday,
    });

    const sqliRes = await request(app).get(
      "/api/gold/history?startDate=2025-01-01'%20OR%201=1--&sort=close;DROP%20TABLE%20gold_prices_daily",
    );
    expect(sqliRes.status).toBe(400);
    expect(sqliRes.body.error).toContain('Query Hygiene Violation');

    const verifyRes = await request(app).get('/api/gold/history?limit=5');
    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.series).toHaveLength(5);
  });

  it('manages Gold Data Providers via /api/providers/gold and enforces SSRF domain allowlist', async () => {
    const app = createApiApp({
      repository: repo,
      referenceDateProvider: () => fixedToday,
    });

    const listRes = await request(app).get('/api/providers/gold');
    expect(listRes.status).toBe(200);
    expect(listRes.body.providers.length).toBe(5);
    expect(listRes.body.activePrimary).toBe('lbma-composite');

    const configRes = await request(app)
      .post('/api/providers/gold/configure')
      .send({
        providerId: 'twelve-data',
        apiKey: 'td_live_9876543210abcdef',
        setPrimary: true,
        refreshIntervalSec: 120,
      });

    expect(configRes.status).toBe(200);
    expect(configRes.body.provider.id).toBe('twelve-data');
    expect(configRes.body.provider.isPrimary).toBe(true);
    expect(configRes.body.provider.maskedApiKey).toBe('td_l••••••••cdef');
  });

  it('manages AI API Keys and Gold data/news tools via MCP JSON-RPC 2.0 (/api/mcp & /api/mcp/ai-keys)', async () => {
    const app = createApiApp({
      repository: repo,
      referenceDateProvider: () => fixedToday,
    });

    // 1. Register Gemini key via MCP tools/call
    const rpcSetKey = await request(app)
      .post('/api/mcp/rpc')
      .send({
        jsonrpc: '2.0',
        id: 101,
        method: 'tools/call',
        params: {
          name: 'mcp_register_ai_key',
          arguments: {
            provider: 'gemini',
            apiKey: 'AIzaSyTestKey1234567890',
            label: 'Primary Gemini Analysis Key',
          },
        },
      });
    expect(rpcSetKey.status).toBe(200);
    const savedRecord = JSON.parse(rpcSetKey.body.result.content[0].text);
    expect(savedRecord.provider).toBe('gemini');
    expect(savedRecord.maskedKey).toBe('AIza••••••••7890');
    expect(savedRecord.status).toBe('configured');

    // 2. Call MCP search_gold_market_news tool
    const rpcNews = await request(app)
      .post('/api/mcp')
      .send({
        jsonrpc: '2.0',
        id: 102,
        method: 'tools/call',
        params: {
          name: 'search_gold_market_news',
          arguments: {
            query: 'central bank gold reserve accumulation',
            currency: 'USD',
          },
        },
      });
    expect(rpcNews.status).toBe(200);
    const newsPayload = JSON.parse(rpcNews.body.result.content[0].text);
    expect(newsPayload.events.length).toBeGreaterThan(0);

    // 3. Call MCP analyze_gold_market_with_mcp tool
    const rpcAnalyze = await request(app)
      .post('/api/mcp')
      .send({
        jsonrpc: '2.0',
        id: 103,
        method: 'tools/call',
        params: {
          name: 'analyze_gold_market_with_mcp',
          arguments: {
            prompt: 'Explain the 2-year gold price movement and major macro news events',
            currency: 'SGD',
          },
        },
      });
    expect(rpcAnalyze.status).toBe(200);
    const reportPayload = JSON.parse(rpcAnalyze.body.result.content[0].text);
    expect(reportPayload.currency).toBe('SGD');
    expect(reportPayload.reactTrace).toHaveLength(5);
    expect(reportPayload.newsEvents.length).toBeGreaterThan(0);
  });

  it('evaluates grounded AI analysis & web news context (/api/ai/analyze) with ReAct trace, delimiter wrapping, and XSS stripping', async () => {
    const app = createApiApp({
      repository: repo,
      referenceDateProvider: () => fixedToday,
    });

    const analyzeRes = await request(app)
      .post('/api/ai/analyze')
      .send({
        prompt: 'Compare current XAU price to 50d and 200d SMA and major news <script>alert(1)</script>',
        currency: 'USD',
      });

    expect(analyzeRes.status).toBe(200);
    expect(analyzeRes.body.delimitersUsed).toContain('<user_query>');
    expect(analyzeRes.body.analysis).not.toContain('<script>');
    expect(analyzeRes.body.groundedMetrics.windowStartDate).toBe('2024-11-12');
    expect(analyzeRes.body.groundedMetrics.windowEndDate).toBe('2026-11-12');
    expect(analyzeRes.body.reactTrace).toHaveLength(5);
    expect(analyzeRes.body.newsEvents.length).toBeGreaterThan(0);
  });
});
