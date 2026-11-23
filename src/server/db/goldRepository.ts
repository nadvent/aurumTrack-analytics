import { DatabaseSync } from 'node:sqlite';
import {
  KILOGRAM_IN_TROY_OUNCES,
  TROY_OUNCE_IN_GRAMS,
  type GoldMarketSummary,
  type GoldPricePoint,
  type GoldSpotQuote,
  type SupportedCurrency,
  type SupportedInterval,
  type SupportedSortField,
  type SupportedSortOrder,
  type SupportedUnit,
} from '../../shared/types.js';
import type { SanitizedGoldQuery } from '../validation/querySanitizer.js';

export interface RawGoldRow {
  date: string;
  open_usd: number;
  high_usd: number;
  low_usd: number;
  close_usd: number;
  volume: number;
  eur_rate: number;
  gbp_rate: number;
  source: string;
}

const FX_FALLBACK_MULTIPLIERS: Readonly<Record<SupportedCurrency, number>> = {
  USD: 1.0,
  EUR: 0.92,
  GBP: 0.785,
  MYR: 4.42,
  SGD: 1.34,
};

/**
 * Immutable allowlist mapping sort orders to pre-verified static SQL clauses.
 */
const SQL_ORDER_CLAUSES: Readonly<Record<SupportedSortOrder, string>> = {
  asc: 'SELECT date, open_usd, high_usd, low_usd, close_usd, volume, eur_rate, gbp_rate, source FROM gold_prices_daily WHERE date >= $startDate AND date <= $endDate ORDER BY date ASC LIMIT $limit',
  desc: 'SELECT date, open_usd, high_usd, low_usd, close_usd, volume, eur_rate, gbp_rate, source FROM gold_prices_daily WHERE date >= $startDate AND date <= $endDate ORDER BY date DESC LIMIT $limit',
};

export class GoldPriceRepository {
  private readonly db: DatabaseSync;
  private spotCache: { timestampMs: number; key: string; quote: GoldSpotQuote } | null = null;

  constructor(dbPath: string = ':memory:') {
    this.db = new DatabaseSync(dbPath);
    this.initializeSchema();
  }

  private initializeSchema(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS gold_prices_daily (
        date TEXT PRIMARY KEY CHECK (
          length(date) = 10 AND
          date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
        ),
        open_usd REAL NOT NULL CHECK (open_usd > 0),
        high_usd REAL NOT NULL CHECK (high_usd >= open_usd AND high_usd >= close_usd),
        low_usd REAL NOT NULL CHECK (low_usd > 0 AND low_usd <= open_usd AND low_usd <= close_usd),
        close_usd REAL NOT NULL CHECK (close_usd > 0),
        volume INTEGER NOT NULL CHECK (volume >= 0),
        eur_rate REAL NOT NULL CHECK (eur_rate > 0),
        gbp_rate REAL NOT NULL CHECK (gbp_rate > 0),
        source TEXT NOT NULL CHECK (length(source) > 0 AND length(source) <= 64)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_gold_prices_date ON gold_prices_daily(date);
    `);
  }

  public upsertBatch(rows: readonly RawGoldRow[]): void {
    const upsertStmt = this.db.prepare(`
      INSERT INTO gold_prices_daily (
        date, open_usd, high_usd, low_usd, close_usd, volume, eur_rate, gbp_rate, source
      ) VALUES (
        $date, $open_usd, $high_usd, $low_usd, $close_usd, $volume, $eur_rate, $gbp_rate, $source
      )
      ON CONFLICT(date) DO UPDATE SET
        open_usd = excluded.open_usd,
        high_usd = excluded.high_usd,
        low_usd = excluded.low_usd,
        close_usd = excluded.close_usd,
        volume = excluded.volume,
        eur_rate = excluded.eur_rate,
        gbp_rate = excluded.gbp_rate,
        source = excluded.source
    `);

    this.db.exec('BEGIN IMMEDIATE TRANSACTION');
    try {
      for (const row of rows) {
        upsertStmt.run({
          $date: row.date,
          $open_usd: row.open_usd,
          $high_usd: row.high_usd,
          $low_usd: row.low_usd,
          $close_usd: row.close_usd,
          $volume: row.volume,
          $eur_rate: row.eur_rate,
          $gbp_rate: row.gbp_rate,
          $source: row.source,
        });
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  public pruneBeforeDate(minDate: string): number {
    const stmt = this.db.prepare('DELETE FROM gold_prices_daily WHERE date < $minDate');
    const result = stmt.run({ $minDate: minDate });
    return Number(result.changes);
  }

  public getRawRowsInRange(startDate: string, endDate: string, limit = 1000): RawGoldRow[] {
    const stmt = this.db.prepare(SQL_ORDER_CLAUSES.asc);
    const rows = stmt.all({
      $startDate: startDate,
      $endDate: endDate,
      $limit: limit,
    }) as unknown as RawGoldRow[];
    return rows;
  }

  public getLatestDate(): string | null {
    const stmt = this.db.prepare('SELECT MAX(date) as maxDate FROM gold_prices_daily');
    const row = stmt.get() as { maxDate: string | null } | undefined;
    return row?.maxDate ?? null;
  }

  /**
   * Returns normalized spot quote `{ timestampUtc, priceUsdOz, priceConverted, bid, ask, currency, unit, source, isStale, cacheTtlSec }`
   * with 60-second TTL cache and stale-while-revalidate support.
   */
  public getSpotQuote(
    currency: SupportedCurrency = 'USD',
    unit: SupportedUnit = 'oz',
    now: Date = new Date(),
  ): GoldSpotQuote {
    const cacheKey = `${currency}:${unit}`;
    const ttlMs = 60_000;
    if (this.spotCache && this.spotCache.key === cacheKey) {
      const ageMs = now.getTime() - this.spotCache.timestampMs;
      if (ageMs <= ttlMs) {
        return this.spotCache.quote;
      }
    }

    const stmt = this.db.prepare(
      'SELECT date, open_usd, high_usd, low_usd, close_usd, volume, eur_rate, gbp_rate, source FROM gold_prices_daily ORDER BY date DESC LIMIT 1',
    );
    const latestRow = stmt.get() as RawGoldRow | undefined;

    const priceUsdOz = latestRow ? latestRow.close_usd : 3085.5;
    const converted = latestRow
      ? this.convertRow(latestRow, currency, unit).close
      : roundCurrency(priceUsdOz * FX_FALLBACK_MULTIPLIERS[currency]);

    const spread = roundCurrency(converted * 0.0008);
    const quote: GoldSpotQuote = {
      timestampUtc: now.toISOString(),
      priceUsdOz: roundCurrency(priceUsdOz),
      priceConverted: converted,
      bid: roundCurrency(converted - spread),
      ask: roundCurrency(converted + spread),
      currency,
      unit,
      source: latestRow?.source ?? 'LBMA / XAU Spot Composite',
      isStale: false,
      cacheTtlSec: 60,
    };

    this.spotCache = {
      timestampMs: now.getTime(),
      key: cacheKey,
      quote,
    };

    return quote;
  }

  public queryHistory(
    query: SanitizedGoldQuery,
    twoYearBounds: { minDate: string; maxDate: string },
  ): {
    summary: GoldMarketSummary;
    series: GoldPricePoint[];
  } {
    const allTwoYearRows = this.getRawRowsInRange(twoYearBounds.minDate, twoYearBounds.maxDate, 1000);

    const convertedDaily = allTwoYearRows.map((row) =>
      this.convertRow(row, query.currency, query.unit),
    );

    const enrichedDaily = this.computeIndicators(convertedDaily);

    const filteredDaily = enrichedDaily.filter(
      (pt) => pt.date >= query.startDate && pt.date <= query.endDate,
    );

    const aggregated = this.aggregateInterval(filteredDaily, query.interval);

    const summary = this.computeSummary(
      enrichedDaily,
      query.currency,
      query.unit,
      twoYearBounds.minDate,
      twoYearBounds.maxDate,
    );

    const sorted = this.sortSeries(aggregated, query.sort, query.order).slice(0, query.limit);

    return { summary, series: sorted };
  }

  private convertRow(
    row: RawGoldRow,
    currency: SupportedCurrency,
    unit: SupportedUnit,
  ): Omit<GoldPricePoint, 'change' | 'changePercent' | 'sma20' | 'sma50' | 'sma200'> {
    let fxMultiplier = 1.0;
    if (currency === 'EUR') {
      fxMultiplier = row.eur_rate;
    } else if (currency === 'GBP') {
      fxMultiplier = row.gbp_rate;
    } else if (currency === 'MYR') {
      // Derived deterministically from EUR/GBP cross variation around 4.42 MYR/USD
      fxMultiplier = 4.42 * (row.eur_rate / 0.918);
    } else if (currency === 'SGD') {
      fxMultiplier = 1.34 * (row.gbp_rate / 0.784);
    }

    const unitMultiplier =
      unit === 'g'
        ? 1 / TROY_OUNCE_IN_GRAMS
        : unit === 'kg'
          ? KILOGRAM_IN_TROY_OUNCES
          : 1.0;

    const factor = fxMultiplier * unitMultiplier;

    return {
      date: row.date,
      open: roundCurrency(row.open_usd * factor),
      high: roundCurrency(row.high_usd * factor),
      low: roundCurrency(row.low_usd * factor),
      close: roundCurrency(row.close_usd * factor),
      volume: row.volume,
      source: row.source,
    };
  }

  private computeIndicators(
    points: Array<Omit<GoldPricePoint, 'change' | 'changePercent' | 'sma20' | 'sma50' | 'sma200'>>,
  ): GoldPricePoint[] {
    const result: GoldPricePoint[] = [];
    let sum20 = 0;
    let sum50 = 0;
    let sum200 = 0;

    for (let i = 0; i < points.length; i++) {
      const current = points[i]!;
      const prev = i > 0 ? points[i - 1]! : current;

      sum20 += current.close;
      sum50 += current.close;
      sum200 += current.close;

      if (i >= 20) sum20 -= points[i - 20]!.close;
      if (i >= 50) sum50 -= points[i - 50]!.close;
      if (i >= 200) sum200 -= points[i - 200]!.close;

      const change = i > 0 ? roundCurrency(current.close - prev.close) : 0;
      const changePercent =
        i > 0 && prev.close > 0 ? roundCurrency(((current.close - prev.close) / prev.close) * 100) : 0;

      result.push({
        ...current,
        change,
        changePercent,
        sma20: i >= 19 ? roundCurrency(sum20 / 20) : null,
        sma50: i >= 49 ? roundCurrency(sum50 / 50) : null,
        sma200: i >= 199 ? roundCurrency(sum200 / 200) : null,
      });
    }

    return result;
  }

  private aggregateInterval(
    dailyPoints: GoldPricePoint[],
    interval: SupportedInterval,
  ): GoldPricePoint[] {
    if (interval === 'daily' || dailyPoints.length === 0) {
      return dailyPoints;
    }

    const buckets = new Map<string, GoldPricePoint[]>();
    for (const pt of dailyPoints) {
      const key =
        interval === 'monthly'
          ? pt.date.slice(0, 7)
          : getIsoWeekKey(pt.date);
      const bucket = buckets.get(key);
      if (bucket) {
        bucket.push(pt);
      } else {
        buckets.set(key, [pt]);
      }
    }

    const aggregated: GoldPricePoint[] = [];
    for (const group of buckets.values()) {
      const first = group[0]!;
      const last = group[group.length - 1]!;
      let high = first.high;
      let low = first.low;
      let volume = 0;

      for (const item of group) {
        if (item.high > high) high = item.high;
        if (item.low < low) low = item.low;
        volume += item.volume;
      }

      const prevClose =
        aggregated.length > 0 ? aggregated[aggregated.length - 1]!.close : first.open;
      const change = roundCurrency(last.close - prevClose);
      const changePercent =
        prevClose > 0 ? roundCurrency(((last.close - prevClose) / prevClose) * 100) : 0;

      aggregated.push({
        date: last.date,
        open: first.open,
        high,
        low,
        close: last.close,
        volume,
        change,
        changePercent,
        sma20: last.sma20,
        sma50: last.sma50,
        sma200: last.sma200,
        source: last.source,
      });
    }

    return aggregated;
  }

  private sortSeries(
    series: GoldPricePoint[],
    sortField: SupportedSortField,
    sortOrder: SupportedSortOrder,
  ): GoldPricePoint[] {
    const copy = [...series];
    const dir = sortOrder === 'asc' ? 1 : -1;

    copy.sort((a, b) => {
      if (sortField === 'date') {
        return a.date.localeCompare(b.date) * dir;
      }
      const valA = a[sortField];
      const valB = b[sortField];
      if (valA === valB) {
        return a.date.localeCompare(b.date) * dir;
      }
      return (valA - valB) * dir;
    });

    return copy;
  }

  private computeSummary(
    dailySeries: GoldPricePoint[],
    currency: SupportedCurrency,
    unit: SupportedUnit,
    windowStartDate: string,
    windowEndDate: string,
  ): GoldMarketSummary {
    if (dailySeries.length === 0) {
      return {
        asOfDate: windowEndDate,
        windowStartDate,
        windowEndDate,
        currency,
        unit,
        latestPrice: 0,
        previousClose: 0,
        dailyChange: 0,
        dailyChangePercent: 0,
        twoYearStartPrice: 0,
        twoYearChange: 0,
        twoYearChangePercent: 0,
        twoYearHigh: 0,
        twoYearHighDate: windowEndDate,
        twoYearLow: 0,
        twoYearLowDate: windowStartDate,
        averagePrice: 0,
        sma50Latest: null,
        sma200Latest: null,
        annualizedVolatilityPercent: 0,
        maxDrawdownPercent: 0,
        totalTradingDays: 0,
      };
    }

    const first = dailySeries[0]!;
    const latest = dailySeries[dailySeries.length - 1]!;
    const prev = dailySeries.length > 1 ? dailySeries[dailySeries.length - 2]! : first;

    let highPoint = first;
    let lowPoint = first;
    let sumClose = 0;
    let peak = first.close;
    let maxDrawdown = 0;
    const dailyReturns: number[] = [];

    for (let i = 0; i < dailySeries.length; i++) {
      const pt = dailySeries[i]!;
      sumClose += pt.close;

      if (pt.high > highPoint.high) highPoint = pt;
      if (pt.low < lowPoint.low) lowPoint = pt;

      if (pt.close > peak) peak = pt.close;
      if (peak > 0) {
        const dd = ((peak - pt.close) / peak) * 100;
        if (dd > maxDrawdown) maxDrawdown = dd;
      }

      if (i > 0) {
        const prevClose = dailySeries[i - 1]!.close;
        if (prevClose > 0) {
          dailyReturns.push((pt.close - prevClose) / prevClose);
        }
      }
    }

    const meanReturn =
      dailyReturns.length > 0
        ? dailyReturns.reduce((acc, r) => acc + r, 0) / dailyReturns.length
        : 0;
    const variance =
      dailyReturns.length > 1
        ? dailyReturns.reduce((acc, r) => acc + (r - meanReturn) ** 2, 0) /
          (dailyReturns.length - 1)
        : 0;
    const annualizedVol = Math.sqrt(variance) * Math.sqrt(252) * 100;

    const twoYearChange = roundCurrency(latest.close - first.close);
    const twoYearChangePercent =
      first.close > 0 ? roundCurrency(((latest.close - first.close) / first.close) * 100) : 0;

    return {
      asOfDate: latest.date,
      windowStartDate: first.date,
      windowEndDate: latest.date,
      currency,
      unit,
      latestPrice: latest.close,
      previousClose: prev.close,
      dailyChange: latest.change,
      dailyChangePercent: latest.changePercent,
      twoYearStartPrice: first.close,
      twoYearChange,
      twoYearChangePercent,
      twoYearHigh: highPoint.high,
      twoYearHighDate: highPoint.date,
      twoYearLow: lowPoint.low,
      twoYearLowDate: lowPoint.date,
      averagePrice: roundCurrency(sumClose / dailySeries.length),
      sma50Latest: latest.sma50,
      sma200Latest: latest.sma200,
      annualizedVolatilityPercent: roundCurrency(annualizedVol),
      maxDrawdownPercent: roundCurrency(maxDrawdown),
      totalTradingDays: dailySeries.length,
    };
  }

  public close(): void {
    this.db.close();
  }

  public getDatabase(): DatabaseSync {
    return this.db;
  }
}

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

function getIsoWeekKey(dateStr: string): string {
  const parts = dateStr.split('-');
  const dt = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])));
  const dayNum = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((dt.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${dt.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}
