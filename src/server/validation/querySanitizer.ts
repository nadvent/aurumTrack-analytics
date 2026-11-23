import { z } from 'zod';
import {
  SUPPORTED_CURRENCIES,
  SUPPORTED_INTERVALS,
  SUPPORTED_RANGES,
  SUPPORTED_SORT_FIELDS,
  SUPPORTED_SORT_ORDERS,
  SUPPORTED_UNITS,
  type SupportedCurrency,
  type SupportedInterval,
  type SupportedRange,
  type SupportedSortField,
  type SupportedSortOrder,
  type SupportedUnit,
} from '../../shared/types.js';

/**
 * Maximum length for any individual query parameter string to prevent DoS / buffer abuse.
 */
const MAX_PARAM_LENGTH = 64;

/**
 * Patterns that indicate SQL injection / comment injection / control-character abuse.
 */
const DANGEROUS_SQL_PATTERN =
  /(--|\/\*|\*\/|;|\b(UNION|SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|EXEC|PRAGMA|ATTACH|DETACH)\b)/i;

const CONTROL_CHARS_PATTERN = /[\u0000-\u001F\u007F]/g;

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Hardcoded SSRF domain allowlist for upstream Gold & AI providers.
 */
export const ALLOWED_UPSTREAM_DOMAINS: ReadonlySet<string> = new Set([
  'prices.lbma.org.uk',
  'metals-api.com',
  'www.alphavantage.co',
  'api.twelvedata.com',
  'query1.finance.yahoo.com',
  'news.google.com',
  'feeds.finance.yahoo.com',
]);

export function assertAllowedUpstreamUrl(urlString: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new QuerySanitizationError(`Invalid upstream URL '${urlString}'.`);
  }
  if (parsed.protocol !== 'https:') {
    throw new QuerySanitizationError('Upstream provider URLs must use HTTPS.');
  }
  if (!ALLOWED_UPSTREAM_DOMAINS.has(parsed.hostname)) {
    throw new QuerySanitizationError(
      `SSRF policy violation: Host '${parsed.hostname}' is not in the hardcoded upstream allowlist.`,
    );
  }
  return parsed;
}

export class QuerySanitizationError extends Error {
  public readonly statusCode: number;
  public readonly details: string[];

  constructor(message: string, details: string[] = [], statusCode = 400) {
    super(message);
    this.name = 'QuerySanitizationError';
    this.details = details;
    this.statusCode = statusCode;
  }
}

/**
 * Strips control characters, trims whitespace, enforces length bounds,
 * and rejects strings containing SQL comment or statement injection tokens.
 */
export function sanitizeRawParam(
  raw: unknown,
  paramName: string,
  maxLength: number = MAX_PARAM_LENGTH,
): string | undefined {
  if (raw === undefined || raw === null || raw === '') {
    return undefined;
  }
  if (Array.isArray(raw)) {
    throw new QuerySanitizationError(
      `Duplicate or array parameter '${paramName}' is not permitted (HTTP Parameter Pollution check).`,
      [`Parameter '${paramName}' must be a single scalar string.`],
    );
  }
  if (typeof raw !== 'string') {
    throw new QuerySanitizationError(`Invalid type for parameter '${paramName}'.`);
  }

  const cleaned = raw.replace(CONTROL_CHARS_PATTERN, '').trim();
  if (cleaned.length === 0) {
    return undefined;
  }
  if (cleaned.length > maxLength) {
    throw new QuerySanitizationError(
      `Parameter '${paramName}' exceeds maximum length of ${maxLength} characters.`,
    );
  }
  if (DANGEROUS_SQL_PATTERN.test(cleaned)) {
    throw new QuerySanitizationError(
      `Parameter '${paramName}' contains disallowed SQL tokens or comment sequences.`,
      [`Rejected value for '${paramName}' due to query hygiene policy.`],
    );
  }

  return cleaned;
}

/**
 * Validates that a string is a strictly valid calendar date in YYYY-MM-DD format
 * (e.g. rejects 2025-02-30 or 2026-13-01).
 */
export function isValidCalendarDate(dateStr: string): boolean {
  if (!ISO_DATE_REGEX.test(dateStr)) {
    return false;
  }
  const parts = dateStr.split('-');
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);

  if (year < 1970 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }

  const utc = new Date(Date.UTC(year, month - 1, day));
  return (
    utc.getUTCFullYear() === year &&
    utc.getUTCMonth() === month - 1 &&
    utc.getUTCDate() === day
  );
}

/**
 * Formats a Date instance to UTC YYYY-MM-DD.
 */
export function formatUtcDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Computes the canonical 2-year window [startDate, endDate] up to `referenceDate` (defaults to today UTC).
 */
export function getTwoYearWindow(referenceDate: Date = new Date()): {
  minDate: string;
  maxDate: string;
} {
  const endUtc = new Date(
    Date.UTC(
      referenceDate.getUTCFullYear(),
      referenceDate.getUTCMonth(),
      referenceDate.getUTCDate(),
    ),
  );
  const startUtc = new Date(
    Date.UTC(
      endUtc.getUTCFullYear() - 2,
      endUtc.getUTCMonth(),
      endUtc.getUTCDate(),
    ),
  );

  return {
    minDate: formatUtcDate(startUtc),
    maxDate: formatUtcDate(endUtc),
  };
}

export function computeRangeStartDate(
  range: SupportedRange,
  maxDateStr: string,
  minDateStr: string,
): string {
  if (range === '2Y') return minDateStr;
  const monthsMap: Record<SupportedRange, number> = {
    '1M': 1,
    '3M': 3,
    '6M': 6,
    '1Y': 12,
    '2Y': 24,
  };
  const months = monthsMap[range];
  const parts = maxDateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(parts[0]!, parts[1]! - 1 - months, parts[2]!));
  const candidate = formatUtcDate(dt);
  return candidate < minDateStr ? minDateStr : candidate;
}

export interface SanitizedGoldQuery {
  range: SupportedRange;
  startDate: string;
  endDate: string;
  currency: SupportedCurrency;
  unit: SupportedUnit;
  interval: SupportedInterval;
  sort: SupportedSortField;
  order: SupportedSortOrder;
  limit: number;
}

const QuerySchema = z.object({
  range: z.enum(SUPPORTED_RANGES),
  startDate: z
    .string()
    .refine(isValidCalendarDate, { message: 'startDate must be a valid YYYY-MM-DD calendar date' }),
  endDate: z
    .string()
    .refine(isValidCalendarDate, { message: 'endDate must be a valid YYYY-MM-DD calendar date' }),
  currency: z.enum(SUPPORTED_CURRENCIES),
  unit: z.enum(SUPPORTED_UNITS),
  interval: z.enum(SUPPORTED_INTERVALS),
  sort: z.enum(SUPPORTED_SORT_FIELDS),
  order: z.enum(SUPPORTED_SORT_ORDERS),
  limit: z.number().int().min(1).max(1000),
});

const ALLOWED_QUERY_KEYS = new Set([
  'range',
  'startDate',
  'endDate',
  'currency',
  'unit',
  'interval',
  'sort',
  'order',
  'limit',
]);

/**
 * Sanitizes and validates raw query parameters for `/api/gold/history`.
 * Enforces allowlisted parameter keys, scalar values, SQL token rejection,
 * calendar validity, and clamps dates to the 2-year window up to today.
 */
export function sanitizeGoldHistoryQuery(
  rawQuery: Record<string, unknown>,
  referenceDate: Date = new Date(),
): SanitizedGoldQuery {
  for (const key of Object.keys(rawQuery)) {
    if (!ALLOWED_QUERY_KEYS.has(key)) {
      throw new QuerySanitizationError(`Unknown query parameter '${key}' is not allowed.`);
    }
  }

  const { minDate, maxDate } = getTwoYearWindow(referenceDate);

  const rawRange = (sanitizeRawParam(rawQuery.range, 'range') ?? '2Y').toUpperCase();
  const parsedRange = z.enum(SUPPORTED_RANGES).safeParse(rawRange);
  if (!parsedRange.success) {
    throw new QuerySanitizationError(`Invalid range '${rawRange}'. Allowed: 1M, 3M, 6M, 1Y, 2Y.`);
  }

  const defaultStartForRange = computeRangeStartDate(parsedRange.data, maxDate, minDate);
  const rawStart = sanitizeRawParam(rawQuery.startDate, 'startDate') ?? defaultStartForRange;
  const rawEnd = sanitizeRawParam(rawQuery.endDate, 'endDate') ?? maxDate;
  const rawCurrency = (sanitizeRawParam(rawQuery.currency, 'currency') ?? 'USD').toUpperCase();
  const rawUnit = (sanitizeRawParam(rawQuery.unit, 'unit') ?? 'oz').toLowerCase();
  const rawInterval = (sanitizeRawParam(rawQuery.interval, 'interval') ?? 'daily').toLowerCase();
  const rawSort = (sanitizeRawParam(rawQuery.sort, 'sort') ?? 'date').toLowerCase();
  const rawOrder = (sanitizeRawParam(rawQuery.order, 'order') ?? 'asc').toLowerCase();
  const rawLimitStr = sanitizeRawParam(rawQuery.limit, 'limit');

  let parsedLimit = 1000;
  if (rawLimitStr !== undefined) {
    if (!/^\d+$/.test(rawLimitStr)) {
      throw new QuerySanitizationError(`Parameter 'limit' must be a positive integer.`);
    }
    parsedLimit = Number.parseInt(rawLimitStr, 10);
  }

  const result = QuerySchema.safeParse({
    range: parsedRange.data,
    startDate: rawStart,
    endDate: rawEnd,
    currency: rawCurrency,
    unit: rawUnit,
    interval: rawInterval,
    sort: rawSort,
    order: rawOrder,
    limit: parsedLimit,
  });

  if (!result.success) {
    const messages = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new QuerySanitizationError('Invalid query parameters.', messages);
  }

  // Clamp startDate and endDate to the 2-year window [minDate, maxDate]
  const clampedStart = result.data.startDate < minDate ? minDate : result.data.startDate;
  const clampedEnd = result.data.endDate > maxDate ? maxDate : result.data.endDate;

  if (clampedStart > clampedEnd) {
    throw new QuerySanitizationError(
      `Invalid date range: startDate (${clampedStart}) must not be after endDate (${clampedEnd}).`,
    );
  }

  return {
    ...result.data,
    startDate: clampedStart,
    endDate: clampedEnd,
  };
}

/**
 * Sanitizes and wraps user AI prompt input (`<= 500` chars) inside explicit data delimiters
 * to prevent prompt injection and strips HTML/script tags from AI Markdown output.
 */
export function sanitizeAiAnalyzeInput(rawBody: unknown): {
  wrappedPrompt: string;
  cleanPrompt: string;
  currency: SupportedCurrency;
} {
  if (!rawBody || typeof rawBody !== 'object') {
    throw new QuerySanitizationError('Request body must be a JSON object.');
  }
  const body = rawBody as Record<string, unknown>;
  const rawPrompt = typeof body.prompt === 'string' ? body.prompt.replace(CONTROL_CHARS_PATTERN, '').trim() : '';
  if (rawPrompt.length === 0) {
    throw new QuerySanitizationError('AI prompt must not be empty.');
  }
  if (rawPrompt.length > 500) {
    throw new QuerySanitizationError('AI prompt exceeds maximum allowed length of 500 characters.');
  }

  const rawCurrency = (sanitizeRawParam(body.currency, 'currency') ?? 'USD').toUpperCase();
  const parsedCurrency = z.enum(SUPPORTED_CURRENCIES).safeParse(rawCurrency);
  if (!parsedCurrency.success) {
    throw new QuerySanitizationError(`Unsupported currency '${rawCurrency}'.`);
  }

  // Strip delimiter tags if user tried to inject closing tags
  const safeUserText = rawPrompt.replace(/<\/?user_query>/gi, '');

  return {
    cleanPrompt: safeUserText,
    wrappedPrompt: `<user_query>${safeUserText}</user_query>`,
    currency: parsedCurrency.data,
  };
}

/**
 * Sanitizes AI text/markdown output by stripping raw HTML tags (`<script>`, `<iframe>`, `<img onerror=...>`, etc.)
 * so rendered output is guaranteed XSS-free.
 */
export function sanitizeAiOutputText(rawMarkdown: string): string {
  return rawMarkdown
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .trim();
}
