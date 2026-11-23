import type {
  AiKeyProviderId,
  AiMarketAnalysisResponse,
  GoldDataProviderId,
  GoldHistoryApiResponse,
  GoldProviderInfo,
  McpAiKeyRecord,
  SupportedCurrency,
  SupportedInterval,
  SupportedSortOrder,
  SupportedUnit,
} from '../shared/types.js';
import { renderGoldChart } from './components/goldChart.js';
import {
  buildSanitizedSearchParams,
  escapeHtml,
  formatPrice,
  formatSignedPercent,
  type ClientQueryState,
} from './utils/sanitize.js';

type ThemeMode = 'system' | 'light' | 'dark';

const state: ClientQueryState = {
  startDate: '',
  endDate: '',
  currency: 'USD',
  unit: 'oz',
  interval: 'daily',
  sort: 'date',
  order: 'desc',
};

let twoYearBounds = { minDate: '', maxDate: '' };
let latestResponse: GoldHistoryApiResponse | null = null;
let currentThemeMode: ThemeMode =
  (localStorage.getItem('aurumtrack_theme_mode') as ThemeMode) || 'system';

// Sidebar & Theme DOM Elements
const settingsSidebar = document.getElementById('settingsSidebar')!;
const openSidebarBtn = document.getElementById('openSidebarBtn')!;
const closeSidebarBtn = document.getElementById('closeSidebarBtn')!;
const themeModeGroup = document.getElementById('themeModeGroup')!;
const resolvedThemeStatus = document.getElementById('resolvedThemeStatus')!;

// Main Dashboard DOM Elements
const windowRangeText = document.getElementById('windowRangeText')!;
const errorBanner = document.getElementById('errorBanner')!;
const kpiLatestPrice = document.getElementById('kpiLatestPrice')!;
const kpiDailyChange = document.getElementById('kpiDailyChange')!;
const kpiTwoYearReturn = document.getElementById('kpiTwoYearReturn')!;
const kpiTwoYearSpread = document.getElementById('kpiTwoYearSpread')!;
const kpiTwoYearHigh = document.getElementById('kpiTwoYearHigh')!;
const kpiTwoYearLow = document.getElementById('kpiTwoYearLow')!;
const kpiAveragePrice = document.getElementById('kpiAveragePrice')!;
const kpiVolatility = document.getElementById('kpiVolatility')!;

const startDateInput = document.getElementById('startDateInput') as HTMLInputElement;
const endDateInput = document.getElementById('endDateInput') as HTMLInputElement;
const currencySelect = document.getElementById('currencySelect') as HTMLSelectElement;
const unitSelect = document.getElementById('unitSelect') as HTMLSelectElement;
const intervalSelect = document.getElementById('intervalSelect') as HTMLSelectElement;
const sortOrderSelect = document.getElementById('sortOrderSelect') as HTMLSelectElement;
const toggleSma20 = document.getElementById('toggleSma20') as HTMLInputElement;
const toggleSma50 = document.getElementById('toggleSma50') as HTMLInputElement;
const toggleSma200 = document.getElementById('toggleSma200') as HTMLInputElement;
const quickRangeGroup = document.getElementById('quickRangeGroup')!;
const exportCsvBtn = document.getElementById('exportCsvBtn')!;

const chartHeading = document.getElementById('chartHeading')!;
const chartSubheading = document.getElementById('chartSubheading')!;
const chartTooltip = document.getElementById('chartTooltip')!;
const chartContainer = document.getElementById('chartContainer')!;
const sanitizedQueryBadge = document.getElementById('sanitizedQueryBadge')!;
const tableCountText = document.getElementById('tableCountText')!;
const ledgerTableBody = document.getElementById('ledgerTableBody')!;

// AI Data Analysis & MCP DOM Elements
const analysisPromptChips = document.getElementById('analysisPromptChips')!;
const aiAnalyzePromptInput = document.getElementById('aiAnalyzePromptInput') as HTMLInputElement;
const runAiAnalyzeBtn = document.getElementById('runAiAnalyzeBtn') as HTMLButtonElement;
const aiAnalysisReportBox = document.getElementById('aiAnalysisReportBox')!;
const aiNewsEventsList = document.getElementById('aiNewsEventsList')!;
const aiReactTraceList = document.getElementById('aiReactTraceList')!;

// Sidebar Settings Controls (MCP Keys & Gold Providers)
const mcpKeyProviderSelect = document.getElementById('mcpKeyProviderSelect') as HTMLSelectElement;
const mcpKeySecretInput = document.getElementById('mcpKeySecretInput') as HTMLInputElement;
const saveMcpKeyBtn = document.getElementById('saveMcpKeyBtn') as HTMLButtonElement;
const mcpKeysList = document.getElementById('mcpKeysList')!;

const goldProviderSelect = document.getElementById('goldProviderSelect') as HTMLSelectElement;
const goldProviderKeyInput = document.getElementById('goldProviderKeyInput') as HTMLInputElement;
const saveGoldProviderKeyBtn = document.getElementById(
  'saveGoldProviderKeyBtn',
) as HTMLButtonElement;
const goldProvidersList = document.getElementById('goldProvidersList')!;

// ============================================================================
// 1. Theme Management (Light / Dark / Browser System Auto-Detection)
// ============================================================================

const systemDarkMediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

function applyThemeMode(mode: ThemeMode): void {
  currentThemeMode = mode;
  localStorage.setItem('aurumtrack_theme_mode', mode);

  const isSystemDark = systemDarkMediaQuery.matches;
  const resolved: 'light' | 'dark' =
    mode === 'system' ? (isSystemDark ? 'dark' : 'light') : mode;

  document.documentElement.setAttribute('data-theme', resolved);

  themeModeGroup.querySelectorAll<HTMLButtonElement>('.theme-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.themeMode === mode);
  });

  resolvedThemeStatus.textContent =
    mode === 'system'
      ? `Active: System Auto-Detected (${resolved.toUpperCase()} mode)`
      : `Active: Manual ${resolved.toUpperCase()} mode`;
}

systemDarkMediaQuery.addEventListener('change', () => {
  if (currentThemeMode === 'system') {
    applyThemeMode('system');
  }
});

themeModeGroup.addEventListener('click', (ev) => {
  const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('.theme-btn');
  if (!btn) return;
  const selectedMode = (btn.dataset.themeMode as ThemeMode) || 'system';
  applyThemeMode(selectedMode);
});

openSidebarBtn.addEventListener('click', () => {
  settingsSidebar.classList.toggle('collapsed');
});

closeSidebarBtn.addEventListener('click', () => {
  settingsSidebar.classList.add('collapsed');
});

// ============================================================================
// 2. 2-Year Gold Price Data & Chart Loading
// ============================================================================

async function loadGoldHistory(): Promise<void> {
  try {
    errorBanner.hidden = true;
    const params = buildSanitizedSearchParams(state);
    const url = `/api/gold/history?${params.toString()}`;

    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
    });

    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as { message?: string };
      throw new Error(errBody.message ?? `Request failed with status ${res.status}`);
    }

    const data = (await res.json()) as GoldHistoryApiResponse;
    latestResponse = data;

    if (!twoYearBounds.minDate) {
      twoYearBounds = {
        minDate: data.summary.windowStartDate,
        maxDate: data.summary.windowEndDate,
      };
      startDateInput.min = twoYearBounds.minDate;
      startDateInput.max = twoYearBounds.maxDate;
      endDateInput.min = twoYearBounds.minDate;
      endDateInput.max = twoYearBounds.maxDate;
    }

    state.startDate = data.meta.startDate;
    state.endDate = data.meta.endDate;
    startDateInput.value = state.startDate;
    endDateInput.value = state.endDate;

    renderDashboard(data);
  } catch (err) {
    errorBanner.textContent =
      err instanceof Error ? err.message : 'Unable to load gold price history.';
    errorBanner.hidden = false;
  }
}

function renderDashboard(data: GoldHistoryApiResponse): void {
  const { summary, meta, series } = data;
  const unitLabel = meta.unit === 'oz' ? 'troy oz' : meta.unit === 'g' ? 'gram' : 'kilogram';

  windowRangeText.textContent = `2Y Window: ${summary.windowStartDate} → ${summary.windowEndDate} (${summary.totalTradingDays} trading days)`;

  kpiLatestPrice.textContent = `${formatPrice(summary.latestPrice, meta.currency)} / ${meta.unit}`;
  const dailySignClass = summary.dailyChange >= 0 ? 'pos' : 'neg';
  kpiDailyChange.className = dailySignClass;
  kpiDailyChange.textContent = `${summary.dailyChange >= 0 ? '+' : ''}${formatPrice(
    summary.dailyChange,
    meta.currency,
  )} (${formatSignedPercent(summary.dailyChangePercent)})`;

  const twoYrClass = summary.twoYearChange >= 0 ? 'pos' : 'neg';
  kpiTwoYearReturn.className = `kpi-value ${twoYrClass}`;
  kpiTwoYearReturn.textContent = formatSignedPercent(summary.twoYearChangePercent);
  kpiTwoYearSpread.textContent = `${
    summary.twoYearChange >= 0 ? '+' : ''
  }${formatPrice(summary.twoYearChange, meta.currency)} since ${summary.windowStartDate}`;

  kpiTwoYearHigh.textContent = `High: ${formatPrice(summary.twoYearHigh, meta.currency)}`;
  kpiTwoYearLow.textContent = `Low: ${formatPrice(summary.twoYearLow, meta.currency)} (${summary.twoYearLowDate})`;

  kpiAveragePrice.textContent = formatPrice(summary.averagePrice, meta.currency);
  kpiVolatility.textContent = `Ann. Vol: ${summary.annualizedVolatilityPercent.toFixed(
    1,
  )}% | Max DD: -${summary.maxDrawdownPercent.toFixed(1)}%`;

  chartHeading.textContent = `XAU/${meta.currency} Spot Gold (${unitLabel}) — ${meta.startDate} to ${meta.endDate}`;
  chartSubheading.textContent = `Interval: ${meta.interval.toUpperCase()} • Source: LBMA / XAU Spot Composite`;

  renderGoldChart(chartContainer, chartTooltip, series, {
    currency: meta.currency,
    unit: meta.unit,
    showSma20: toggleSma20.checked,
    showSma50: toggleSma50.checked,
    showSma200: toggleSma200.checked,
  });

  const queryPairs = Object.entries(meta.sanitizedQuery)
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  sanitizedQueryBadge.textContent = `GET /api/gold/history?${queryPairs}`;

  tableCountText.textContent = `Showing ${series.length} sanitized ${meta.interval} records (${meta.currency}/${meta.unit})`;

  ledgerTableBody.innerHTML = series
    .map((pt) => {
      const cls = pt.change >= 0 ? 'pos' : 'neg';
      return `
        <tr>
          <td>${escapeHtml(pt.date)}</td>
          <td>${escapeHtml(formatPrice(pt.open, meta.currency))}</td>
          <td>${escapeHtml(formatPrice(pt.high, meta.currency))}</td>
          <td>${escapeHtml(formatPrice(pt.low, meta.currency))}</td>
          <td><strong>${escapeHtml(formatPrice(pt.close, meta.currency))}</strong></td>
          <td class="${cls}">${escapeHtml(formatSignedPercent(pt.changePercent))}</td>
          <td>${pt.sma20 !== null ? escapeHtml(formatPrice(pt.sma20, meta.currency)) : '—'}</td>
          <td>${pt.sma50 !== null ? escapeHtml(formatPrice(pt.sma50, meta.currency)) : '—'}</td>
          <td>${escapeHtml(pt.volume.toLocaleString('en-US'))}</td>
        </tr>
      `;
    })
    .join('');
}

// ============================================================================
// 3. AI Market Data Analysis & Web News Context (via MCP + ReAct)
// ============================================================================

async function runMcpMarketAnalysis(): Promise<void> {
  try {
    runAiAnalyzeBtn.disabled = true;
    runAiAnalyzeBtn.textContent = 'Searching & Analyzing...';

    const prompt =
      aiAnalyzePromptInput.value.trim() ||
      'Why did gold rally over the last 2 years and what major news events drove the highs?';

    const res = await fetch('/api/ai/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        currency: state.currency,
      }),
    });

    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { message?: string };
      throw new Error(err.message ?? 'Failed to execute MCP market analysis');
    }

    const data = (await res.json()) as AiMarketAnalysisResponse;
    aiAnalysisReportBox.textContent = data.analysis;

    aiNewsEventsList.innerHTML = data.newsEvents
      .map((ev) => {
        const signCls = ev.priceImpactPercent >= 0 ? 'pos' : 'neg';
        return `
          <div class="news-card">
            <div class="news-card-header">
              <span><strong>${escapeHtml(ev.date)}</strong> &bull; ${escapeHtml(ev.source)}</span>
              <span class="${signCls}">${escapeHtml(formatSignedPercent(ev.priceImpactPercent))}</span>
            </div>
            <div class="news-headline">${escapeHtml(ev.headline)}</div>
            <div style="color: var(--text-secondary);">${escapeHtml(ev.summary)}</div>
          </div>
        `;
      })
      .join('');

    aiReactTraceList.innerHTML = data.reactTrace
      .map(
        (step) => `
          <div class="react-step-item">
            <div class="react-step-header">
              <span>Step ${step.stepNumber}: MCP \`${escapeHtml(step.mcpTool)}\`</span>
              <span>ReAct</span>
            </div>
            <div style="margin-bottom: 0.2rem;"><strong>Thought:</strong> ${escapeHtml(
              step.thought,
            )}</div>
            <div class="react-step-obs"><strong>Observation:</strong> ${escapeHtml(
              step.observation,
            )}</div>
          </div>
        `,
      )
      .join('');
  } catch (err) {
    errorBanner.textContent =
      err instanceof Error ? err.message : 'Error running MCP market analysis.';
    errorBanner.hidden = false;
  } finally {
    runAiAnalyzeBtn.disabled = false;
    runAiAnalyzeBtn.textContent = 'Analyze Data & Search News (MCP)';
  }
}

analysisPromptChips.addEventListener('click', (ev) => {
  const chip = (ev.target as HTMLElement).closest<HTMLButtonElement>('.chip-btn');
  if (!chip) return;
  aiAnalyzePromptInput.value = chip.dataset.prompt ?? '';
  void runMcpMarketAnalysis();
});

runAiAnalyzeBtn.addEventListener('click', () => {
  void runMcpMarketAnalysis();
});

// ============================================================================
// 4. Sidebar Settings: MCP AI Keys & Gold Data Provider Lists
// ============================================================================

async function loadMcpKeysAndGoldProviders(): Promise<void> {
  const [keysRes, providersRes] = await Promise.all([
    fetch('/api/mcp/ai-keys'),
    fetch('/api/providers/gold'),
  ]);

  if (keysRes.ok) {
    const keysData = (await keysRes.json()) as { keys: McpAiKeyRecord[] };
    mcpKeysList.innerHTML = keysData.keys
      .map(
        (k) => `
        <div class="provider-row">
          <div>
            <strong>${escapeHtml(k.provider.toUpperCase())}</strong>
            <div style="color: var(--text-secondary); font-size: 0.72rem;">${escapeHtml(
              k.mcpResourceUri,
            )}</div>
          </div>
          <div style="display: flex; align-items: center; gap: 0.4rem;">
            <span class="${k.status === 'configured' ? 'pos' : ''}">${escapeHtml(
              k.maskedKey,
            )}</span>
            ${
              k.status === 'configured'
                ? `<button type="button" class="btn-secondary delete-mcp-key-btn" data-provider="${escapeHtml(
                    k.provider,
                  )}">&times;</button>`
                : ''
            }
          </div>
        </div>
      `,
      )
      .join('');
  }

  if (providersRes.ok) {
    const provData = (await providersRes.json()) as { providers: GoldProviderInfo[] };
    goldProvidersList.innerHTML = provData.providers
      .map(
        (p) => `
        <div class="provider-row">
          <div>
            <strong>${escapeHtml(p.name)}</strong>
            <div style="color: var(--text-secondary); font-size: 0.72rem;">
              ${escapeHtml(p.status.toUpperCase())} &bull; ${p.reliabilityScore}% &bull; ${
                p.maskedApiKey ? `Key: ${escapeHtml(p.maskedApiKey)}` : 'Public/Composite'
              }
            </div>
          </div>
          <div style="display: flex; gap: 0.35rem; align-items: center;">
            ${
              p.isPrimary
                ? `<span class="badge-tag">Primary</span>`
                : `<button type="button" class="btn-secondary activate-gold-prov-btn" data-id="${escapeHtml(
                    p.id,
                  )}">Set Primary</button>`
            }
          </div>
        </div>
      `,
      )
      .join('');
  }
}

saveMcpKeyBtn.addEventListener('click', async () => {
  try {
    errorBanner.hidden = true;
    const provider = mcpKeyProviderSelect.value as AiKeyProviderId;
    const apiKey = mcpKeySecretInput.value.trim();

    const res = await fetch('/api/mcp/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: {
          name: 'mcp_register_ai_key',
          arguments: { provider, apiKey },
        },
      }),
    });

    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { message?: string };
      throw new Error(err.message ?? 'Failed to register AI key via MCP');
    }

    mcpKeySecretInput.value = '';
    await loadMcpKeysAndGoldProviders();
    await runMcpMarketAnalysis();
  } catch (err) {
    errorBanner.textContent = err instanceof Error ? err.message : 'MCP Key update error';
    errorBanner.hidden = false;
  }
});

mcpKeysList.addEventListener('click', async (ev) => {
  const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('.delete-mcp-key-btn');
  if (!btn) return;
  const provider = btn.dataset.provider;
  if (!provider) return;

  const res = await fetch(`/api/mcp/ai-keys/${encodeURIComponent(provider)}`, {
    method: 'DELETE',
  });
  if (res.ok) {
    await loadMcpKeysAndGoldProviders();
  }
});

saveGoldProviderKeyBtn.addEventListener('click', async () => {
  try {
    errorBanner.hidden = true;
    const providerId = goldProviderSelect.value as GoldDataProviderId;
    const apiKey = goldProviderKeyInput.value.trim();

    const res = await fetch('/api/providers/gold/configure', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        providerId,
        ...(apiKey ? { apiKey } : {}),
        setPrimary: true,
      }),
    });

    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { message?: string };
      throw new Error(err.message ?? 'Failed to update Gold Data Provider');
    }

    goldProviderKeyInput.value = '';
    await loadMcpKeysAndGoldProviders();
    await loadGoldHistory();
  } catch (err) {
    errorBanner.textContent =
      err instanceof Error ? err.message : 'Gold provider configuration error';
    errorBanner.hidden = false;
  }
});

goldProvidersList.addEventListener('click', async (ev) => {
  const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('.activate-gold-prov-btn');
  if (!btn) return;
  const providerId = btn.dataset.id as GoldDataProviderId;

  const res = await fetch('/api/providers/gold/configure', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerId, setPrimary: true }),
  });

  if (res.ok) {
    await loadMcpKeysAndGoldProviders();
    await loadGoldHistory();
  }
});

// Chart & Table Filter Event Listeners
quickRangeGroup.addEventListener('click', (ev) => {
  const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('.range-btn');
  if (!btn || !twoYearBounds.maxDate) return;

  quickRangeGroup.querySelectorAll('.range-btn').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');

  const months = Number(btn.dataset.months ?? 24);
  if (months >= 24) {
    state.startDate = twoYearBounds.minDate;
    state.endDate = twoYearBounds.maxDate;
  } else {
    const parts = twoYearBounds.maxDate.split('-').map(Number);
    const dt = new Date(Date.UTC(parts[0]!, parts[1]! - 1 - months, parts[2]!));
    const y = dt.getUTCFullYear();
    const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const d = String(dt.getUTCDate()).padStart(2, '0');
    const computedStart = `${y}-${m}-${d}`;
    state.startDate = computedStart < twoYearBounds.minDate ? twoYearBounds.minDate : computedStart;
    state.endDate = twoYearBounds.maxDate;
  }

  void loadGoldHistory();
});

startDateInput.addEventListener('change', () => {
  state.startDate = startDateInput.value;
  quickRangeGroup.querySelectorAll('.range-btn').forEach((b) => b.classList.remove('active'));
  void loadGoldHistory();
});

endDateInput.addEventListener('change', () => {
  state.endDate = endDateInput.value;
  quickRangeGroup.querySelectorAll('.range-btn').forEach((b) => b.classList.remove('active'));
  void loadGoldHistory();
});

currencySelect.addEventListener('change', () => {
  state.currency = currencySelect.value as SupportedCurrency;
  void loadGoldHistory();
  void runMcpMarketAnalysis();
});

unitSelect.addEventListener('change', () => {
  state.unit = unitSelect.value as SupportedUnit;
  void loadGoldHistory();
});

intervalSelect.addEventListener('change', () => {
  state.interval = intervalSelect.value as SupportedInterval;
  void loadGoldHistory();
});

sortOrderSelect.addEventListener('change', () => {
  state.order = sortOrderSelect.value as SupportedSortOrder;
  void loadGoldHistory();
});

const redrawChartOnly = (): void => {
  if (!latestResponse) return;
  renderGoldChart(chartContainer, chartTooltip, latestResponse.series, {
    currency: latestResponse.meta.currency,
    unit: latestResponse.meta.unit,
    showSma20: toggleSma20.checked,
    showSma50: toggleSma50.checked,
    showSma200: toggleSma200.checked,
  });
};

toggleSma20.addEventListener('change', redrawChartOnly);
toggleSma50.addEventListener('change', redrawChartOnly);
toggleSma200.addEventListener('change', redrawChartOnly);

exportCsvBtn.addEventListener('click', () => {
  const params = buildSanitizedSearchParams(state);
  window.location.href = `/api/gold/export.csv?${params.toString()}`;
});

// Initialize on page load
applyThemeMode(currentThemeMode);
void (async () => {
  await loadGoldHistory();
  await loadMcpKeysAndGoldProviders();
  await runMcpMarketAnalysis();
})();
