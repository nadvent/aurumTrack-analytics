export const SUPPORTED_CURRENCIES = ['USD', 'EUR', 'GBP', 'MYR', 'SGD'] as const;
export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

export const SUPPORTED_RANGES = ['1M', '3M', '6M', '1Y', '2Y'] as const;
export type SupportedRange = (typeof SUPPORTED_RANGES)[number];

export const SUPPORTED_UNITS = ['oz', 'g', 'kg'] as const;
export type SupportedUnit = (typeof SUPPORTED_UNITS)[number];

export const SUPPORTED_INTERVALS = ['daily', 'weekly', 'monthly'] as const;
export type SupportedInterval = (typeof SUPPORTED_INTERVALS)[number];

export const SUPPORTED_SORT_ORDERS = ['asc', 'desc'] as const;
export type SupportedSortOrder = (typeof SUPPORTED_SORT_ORDERS)[number];

export const SUPPORTED_SORT_FIELDS = ['date', 'close', 'high', 'low', 'volume'] as const;
export type SupportedSortField = (typeof SUPPORTED_SORT_FIELDS)[number];

export const TROY_OUNCE_IN_GRAMS = 31.1034768;
export const KILOGRAM_IN_TROY_OUNCES = 1000 / TROY_OUNCE_IN_GRAMS; // ~32.1507466

export const GOLD_DATA_PROVIDER_IDS = [
  'lbma-composite',
  'metals-api',
  'alpha-vantage',
  'twelve-data',
  'yahoo-finance-xau',
] as const;
export type GoldDataProviderId = (typeof GOLD_DATA_PROVIDER_IDS)[number];

export const AI_KEY_PROVIDER_IDS = [
  'gemini',
  'openai',
  'anthropic',
  'openrouter',
] as const;
export type AiKeyProviderId = (typeof AI_KEY_PROVIDER_IDS)[number];

export const DESIGN_AESTHETIC_PRESETS = [
  'clean-modern-light',
  'nordic-minimal-slate',
  'swiss-editorial-ivory',
  'obsidian-gold-modern',
] as const;
export type DesignAestheticPreset = (typeof DESIGN_AESTHETIC_PRESETS)[number];

export interface GoldSpotQuote {
  timestampUtc: string;
  priceUsdOz: number;
  priceConverted: number;
  bid: number;
  ask: number;
  currency: SupportedCurrency;
  unit: SupportedUnit;
  source: string;
  isStale: boolean;
  cacheTtlSec: number;
}

export interface GoldPricePoint {
  date: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  change: number;
  changePercent: number;
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  source: string;
}

export interface GoldMarketSummary {
  asOfDate: string;
  windowStartDate: string;
  windowEndDate: string;
  currency: SupportedCurrency;
  unit: SupportedUnit;
  latestPrice: number;
  previousClose: number;
  dailyChange: number;
  dailyChangePercent: number;
  twoYearStartPrice: number;
  twoYearChange: number;
  twoYearChangePercent: number;
  twoYearHigh: number;
  twoYearHighDate: string;
  twoYearLow: number;
  twoYearLowDate: string;
  averagePrice: number;
  sma50Latest: number | null;
  sma200Latest: number | null;
  annualizedVolatilityPercent: number;
  maxDrawdownPercent: number;
  totalTradingDays: number;
}

export interface GoldHistoryApiResponse {
  meta: {
    range: SupportedRange;
    currency: SupportedCurrency;
    unit: SupportedUnit;
    interval: SupportedInterval;
    startDate: string;
    endDate: string;
    sort: SupportedSortField;
    order: SupportedSortOrder;
    count: number;
    isStale: boolean;
    cacheTtlSec: number;
    sanitizedQuery: Record<string, string>;
    generatedAt: string;
  };
  summary: GoldMarketSummary;
  series: GoldPricePoint[];
}

export interface GoldProviderInfo {
  id: GoldDataProviderId;
  name: string;
  endpointUrl: string;
  allowedDomain: string;
  status: 'active' | 'standby' | 'configured';
  isPrimary: boolean;
  hasApiKey: boolean;
  maskedApiKey: string | null;
  refreshIntervalSec: number;
  lastSyncedAt: string;
  reliabilityScore: number;
}

export interface McpAiKeyRecord {
  provider: AiKeyProviderId;
  label: string;
  maskedKey: string;
  fingerprintSha256: string;
  mcpResourceUri: string;
  status: 'configured' | 'missing';
  updatedAt: string;
}

export interface ReActStep {
  stepNumber: number;
  thought: string;
  action:
    | 'inspect_market_context'
    | 'resolve_mcp_ai_credentials'
    | 'synthesize_clean_aesthetic_tokens'
    | 'audit_wcag_contrast_and_spacing'
    | 'finalize_ui_specification';
  actionInput: Record<string, string | number | boolean>;
  observation: string;
  timestamp: string;
}

export interface DesignSystemTokens {
  presetId: DesignAestheticPreset;
  name: string;
  description: string;
  mode: 'light' | 'dark';
  cssVariables: {
    '--bg-primary': string;
    '--bg-card': string;
    '--bg-card-elevated': string;
    '--border-subtle': string;
    '--border-muted': string;
    '--gold-bright': string;
    '--gold-primary': string;
    '--gold-deep': string;
    '--text-primary': string;
    '--text-secondary': string;
    '--text-muted': string;
    '--radius-card': string;
    '--shadow-card': string;
    '--font-heading': string;
  };
  layoutDensity: 'spacious' | 'balanced' | 'compact';
  contrastRatioTextToBg: number;
  wcagLevel: 'AAA' | 'AA';
}

export interface DesignAgentPlanResponse {
  planId: string;
  goal: string;
  preset: DesignAestheticPreset;
  mcpProviderUsed: AiKeyProviderId;
  mcpKeyConfigured: boolean;
  steps: ReActStep[];
  finalAnswer: string;
  designTokens: DesignSystemTokens;
  createdAt: string;
}

export interface MarketNewsEvent {
  date: string;
  headline: string;
  source: string;
  url: string;
  category: 'central-bank' | 'monetary-policy' | 'geopolitics' | 'inflation-fx' | 'market-structure';
  priceImpactPercent: number;
  summary: string;
}

export interface AiAnalysisReActStep {
  stepNumber: number;
  thought: string;
  mcpTool:
    | 'get_gold_history'
    | 'get_gold_spot'
    | 'search_gold_market_news'
    | 'correlate_events_with_price_spikes'
    | 'synthesize_grounded_report';
  toolInput: Record<string, string | number | boolean>;
  observation: string;
  timestamp: string;
}

export interface AiMarketAnalysisResponse {
  delimitersUsed: string;
  query: string;
  currency: SupportedCurrency;
  mcpServer: string;
  webSearchPerformed: boolean;
  liveWebHeadlinesCount: number;
  groundedMetrics: {
    windowStartDate: string;
    windowEndDate: string;
    latestPrice: number;
    twoYearLow: number;
    twoYearLowDate: string;
    twoYearHigh: number;
    twoYearHighDate: string;
    twoYearChangePercent: number;
    sma20: number | null;
    sma50: number | null;
    sma200: number | null;
    annualizedVolatilityPercent: number;
    maxDrawdownPercent: number;
    biggestRallyDate: string;
    biggestRallyPercent: number;
    biggestPullbackDate: string;
    biggestPullbackPercent: number;
  };
  newsEvents: MarketNewsEvent[];
  reactTrace: AiAnalysisReActStep[];
  analysis: string;
  sanitized: boolean;
  generatedAt: string;
}
