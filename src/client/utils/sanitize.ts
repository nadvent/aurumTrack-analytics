import {
  SUPPORTED_CURRENCIES,
  SUPPORTED_INTERVALS,
  SUPPORTED_SORT_FIELDS,
  SUPPORTED_SORT_ORDERS,
  SUPPORTED_UNITS,
  type SupportedCurrency,
  type SupportedInterval,
  type SupportedSortField,
  type SupportedSortOrder,
  type SupportedUnit,
} from '../../shared/types.js';

const HTML_ESCAPE_MAP: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Escapes untrusted or dynamic strings before inserting into HTML templates.
 */
export function escapeHtml(input: string | number | null | undefined): string {
  if (input === null || input === undefined) return '';
  return String(input).replace(/[&<>"']/g, (ch) => HTML_ESCAPE_MAP[ch] ?? ch);
}

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface ClientQueryState {
  startDate: string;
  endDate: string;
  currency: SupportedCurrency;
  unit: SupportedUnit;
  interval: SupportedInterval;
  sort: SupportedSortField;
  order: SupportedSortOrder;
}

/**
 * Sanitizes client filter state before building `URLSearchParams` for API requests.
 */
export function buildSanitizedSearchParams(state: Partial<ClientQueryState>): URLSearchParams {
  const params = new URLSearchParams();

  if (state.startDate && ISO_DATE_PATTERN.test(state.startDate.trim())) {
    params.set('startDate', state.startDate.trim());
  }
  if (state.endDate && ISO_DATE_PATTERN.test(state.endDate.trim())) {
    params.set('endDate', state.endDate.trim());
  }
  if (state.currency && (SUPPORTED_CURRENCIES as readonly string[]).includes(state.currency)) {
    params.set('currency', state.currency);
  }
  if (state.unit && (SUPPORTED_UNITS as readonly string[]).includes(state.unit)) {
    params.set('unit', state.unit);
  }
  if (state.interval && (SUPPORTED_INTERVALS as readonly string[]).includes(state.interval)) {
    params.set('interval', state.interval);
  }
  if (state.sort && (SUPPORTED_SORT_FIELDS as readonly string[]).includes(state.sort)) {
    params.set('sort', state.sort);
  }
  if (state.order && (SUPPORTED_SORT_ORDERS as readonly string[]).includes(state.order)) {
    params.set('order', state.order);
  }

  return params;
}

export function formatPrice(
  value: number,
  currency: SupportedCurrency,
  fractionDigits = 2,
): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value);
}

export function formatSignedPercent(value: number): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}
