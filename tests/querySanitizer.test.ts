import { describe, expect, it } from 'vitest';
import {
  QuerySanitizationError,
  getTwoYearWindow,
  isValidCalendarDate,
  sanitizeGoldHistoryQuery,
  sanitizeRawParam,
} from '../src/server/validation/querySanitizer.js';

describe('Query Hygiene & Input Sanitization', () => {
  const refDate = new Date('2026-11-12T12:00:00Z');

  it('computes exact 2-year window up to today', () => {
    const window = getTwoYearWindow(refDate);
    expect(window).toEqual({
      minDate: '2024-11-12',
      maxDate: '2026-11-12',
    });
  });

  it('validates real calendar dates and rejects impossible dates', () => {
    expect(isValidCalendarDate('2026-11-12')).toBe(true);
    expect(isValidCalendarDate('2024-02-29')).toBe(true); // 2024 is leap year
    expect(isValidCalendarDate('2025-02-29')).toBe(false); // 2025 is not leap year
    expect(isValidCalendarDate('2026-02-30')).toBe(false);
    expect(isValidCalendarDate('2026-13-01')).toBe(false);
    expect(isValidCalendarDate('2026/11/12')).toBe(false);
  });

  it('blocks SQL injection payloads, comments, and semicolons', () => {
    const payloads = [
      "2025-01-01'; DROP TABLE gold_prices_daily;--",
      '2025-01-01 UNION SELECT * FROM sqlite_master',
      'USD/*comment*/',
      'date; PRAGMA table_info(gold_prices_daily)',
      '1 OR 1=1--',
    ];

    for (const malicious of payloads) {
      expect(() => sanitizeRawParam(malicious, 'startDate')).toThrow(QuerySanitizationError);
    }
  });

  it('rejects HTTP Parameter Pollution (array parameters)', () => {
    expect(() =>
      sanitizeGoldHistoryQuery({ currency: ['USD', 'EUR'] }, refDate),
    ).toThrow(QuerySanitizationError);
  });

  it('rejects unknown query parameters not in the allowlist', () => {
    expect(() =>
      sanitizeGoldHistoryQuery({ __proto__: 'polluted', evilParam: '1' }, refDate),
    ).toThrow(QuerySanitizationError);
  });

  it('clamps out-of-range dates to the 2-year window [today - 2 years, today]', () => {
    const sanitized = sanitizeGoldHistoryQuery(
      {
        startDate: '2019-01-01',
        endDate: '2029-12-31',
        currency: 'eur',
        unit: 'G',
        interval: 'WEEKLY',
      },
      refDate,
    );

    expect(sanitized.startDate).toBe('2024-11-12');
    expect(sanitized.endDate).toBe('2026-11-12');
    expect(sanitized.currency).toBe('EUR');
    expect(sanitized.unit).toBe('g');
    expect(sanitized.interval).toBe('weekly');
  });

  it('rejects inverted date ranges where startDate > endDate', () => {
    expect(() =>
      sanitizeGoldHistoryQuery(
        {
          startDate: '2026-06-01',
          endDate: '2025-06-01',
        },
        refDate,
      ),
    ).toThrow(QuerySanitizationError);
  });
});
