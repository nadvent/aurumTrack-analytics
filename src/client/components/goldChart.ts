import type { GoldPricePoint, SupportedCurrency, SupportedUnit } from '../../shared/types.js';
import { escapeHtml, formatPrice, formatSignedPercent } from '../utils/sanitize.js';

export interface ChartRenderOptions {
  currency: SupportedCurrency;
  unit: SupportedUnit;
  showSma20: boolean;
  showSma50: boolean;
  showSma200: boolean;
}

/**
 * Renders an interactive, responsive SVG financial chart with crosshair inspection,
 * high/low markers, area gradient, and optional SMA-20 / SMA-50 / SMA-200 overlays.
 */
export function renderGoldChart(
  container: HTMLElement,
  tooltipEl: HTMLElement,
  rawSeries: readonly GoldPricePoint[],
  options: ChartRenderOptions,
): void {
  // Always plot chronologically left-to-right on the chart
  const series = [...rawSeries].sort((a, b) => a.date.localeCompare(b.date));

  if (series.length === 0) {
    container.innerHTML = `<div class="chart-empty">No gold price records found for the selected date range.</div>`;
    return;
  }

  const width = 1040;
  const height = 430;
  const pad = { top: 28, right: 78, bottom: 42, left: 18 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  let minVal = Infinity;
  let maxVal = -Infinity;
  let highIdx = 0;
  let lowIdx = 0;

  for (let i = 0; i < series.length; i++) {
    const pt = series[i]!;
    if (pt.low < minVal) {
      minVal = pt.low;
      lowIdx = i;
    }
    if (pt.high > maxVal) {
      maxVal = pt.high;
      highIdx = i;
    }
    if (options.showSma20 && pt.sma20 !== null) {
      if (pt.sma20 < minVal) minVal = pt.sma20;
      if (pt.sma20 > maxVal) maxVal = pt.sma20;
    }
    if (options.showSma50 && pt.sma50 !== null) {
      if (pt.sma50 < minVal) minVal = pt.sma50;
      if (pt.sma50 > maxVal) maxVal = pt.sma50;
    }
    if (options.showSma200 && pt.sma200 !== null) {
      if (pt.sma200 < minVal) minVal = pt.sma200;
      if (pt.sma200 > maxVal) maxVal = pt.sma200;
    }
  }

  const range = Math.max(1, maxVal - minVal);
  const yMin = minVal - range * 0.06;
  const yMax = maxVal + range * 0.08;
  const ySpan = yMax - yMin;

  const getX = (index: number): number => {
    if (series.length === 1) return pad.left + plotW / 2;
    return pad.left + (index / (series.length - 1)) * plotW;
  };

  const getY = (val: number): number => {
    return pad.top + plotH - ((val - yMin) / ySpan) * plotH;
  };

  // Build main close price polyline & area path
  const closeCoords = series.map((pt, i) => `${getX(i).toFixed(2)},${getY(pt.close).toFixed(2)}`);
  const closeLinePath = `M ${closeCoords.join(' L ')}`;
  const areaPath = `${closeLinePath} L ${getX(series.length - 1).toFixed(2)},${(pad.top + plotH).toFixed(2)} L ${getX(0).toFixed(2)},${(pad.top + plotH).toFixed(2)} Z`;

  const buildIndicatorPath = (getter: (pt: GoldPricePoint) => number | null): string => {
    const segments: string[] = [];
    let started = false;
    for (let i = 0; i < series.length; i++) {
      const val = getter(series[i]!);
      if (val === null) continue;
      const cmd = started ? 'L' : 'M';
      segments.push(`${cmd} ${getX(i).toFixed(2)},${getY(val).toFixed(2)}`);
      started = true;
    }
    return segments.join(' ');
  };

  const sma20Path = options.showSma20 ? buildIndicatorPath((p) => p.sma20) : '';
  const sma50Path = options.showSma50 ? buildIndicatorPath((p) => p.sma50) : '';
  const sma200Path = options.showSma200 ? buildIndicatorPath((p) => p.sma200) : '';

  // Horizontal Y-axis grid lines (5 ticks)
  const yTicks = 5;
  const gridLinesHtml: string[] = [];
  for (let t = 0; t <= yTicks; t++) {
    const ratio = t / yTicks;
    const val = yMax - ratio * ySpan;
    const y = (pad.top + ratio * plotH).toFixed(2);
    gridLinesHtml.push(`
      <line x1="${pad.left}" y1="${y}" x2="${width - pad.right}" y2="${y}" class="chart-grid-line" />
      <text x="${width - pad.right + 8}" y="${Number(y) + 4}" class="chart-axis-label">${escapeHtml(
        formatPrice(val, options.currency, 0),
      )}</text>
    `);
  }

  // X-axis date labels (6 evenly spaced ticks)
  const xTickCount = Math.min(6, series.length - 1);
  const xLabelsHtml: string[] = [];
  if (xTickCount > 0) {
    for (let t = 0; t <= xTickCount; t++) {
      const idx = Math.round((t / xTickCount) * (series.length - 1));
      const pt = series[idx]!;
      const x = getX(idx).toFixed(2);
      xLabelsHtml.push(`
        <line x1="${x}" y1="${pad.top + plotH}" x2="${x}" y2="${pad.top + plotH + 6}" class="chart-tick" />
        <text x="${x}" y="${height - 12}" text-anchor="middle" class="chart-axis-label">${escapeHtml(
          pt.date,
        )}</text>
      `);
    }
  }

  const highPt = series[highIdx]!;
  const lowPt = series[lowIdx]!;
  const highX = getX(highIdx).toFixed(2);
  const highY = getY(highPt.high).toFixed(2);
  const lowX = getX(lowIdx).toFixed(2);
  const lowY = getY(lowPt.low).toFixed(2);

  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" class="gold-svg-chart" role="img" aria-label="2-Year Historical Gold Price Chart">
      <defs>
        <linearGradient id="goldAreaGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#f5c451" stop-opacity="0.34" />
          <stop offset="70%" stop-color="#d4af37" stop-opacity="0.08" />
          <stop offset="100%" stop-color="#d4af37" stop-opacity="0.0" />
        </linearGradient>
      </defs>

      ${gridLinesHtml.join('')}
      ${xLabelsHtml.join('')}

      <path d="${areaPath}" fill="url(#goldAreaGrad)" />
      ${
        sma200Path
          ? `<path d="${sma200Path}" fill="none" stroke="#a855f7" stroke-width="1.6" stroke-dasharray="5,4" opacity="0.85" />`
          : ''
      }
      ${
        sma50Path
          ? `<path d="${sma50Path}" fill="none" stroke="#38bdf8" stroke-width="1.75" opacity="0.9" />`
          : ''
      }
      ${
        sma20Path
          ? `<path d="${sma20Path}" fill="none" stroke="#22c55e" stroke-width="1.6" opacity="0.9" />`
          : ''
      }
      <path d="${closeLinePath}" fill="none" stroke="#f5c451" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round" />

      <!-- High & Low callout pins -->
      <circle cx="${highX}" cy="${highY}" r="4" fill="#22c55e" stroke="#0b0f17" stroke-width="1.5" />
      <circle cx="${lowX}" cy="${lowY}" r="4" fill="#f43f5e" stroke="#0b0f17" stroke-width="1.5" />

      <!-- Interactive Crosshair Elements -->
      <line id="chartCrosshairV" x1="0" y1="${pad.top}" x2="0" y2="${pad.top + plotH}" class="chart-crosshair" visibility="hidden" />
      <line id="chartCrosshairH" x1="${pad.left}" y1="0" x2="${width - pad.right}" y2="0" class="chart-crosshair" visibility="hidden" />
      <circle id="chartActiveDot" cx="0" cy="0" r="5.5" fill="#f5c451" stroke="#0b0f17" stroke-width="2" visibility="hidden" />

      <!-- Transparent pointer capture overlay -->
      <rect
        id="chartHitOverlay"
        x="${pad.left}"
        y="${pad.top}"
        width="${plotW}"
        height="${plotH}"
        fill="transparent"
        style="cursor: crosshair;"
      />
    </svg>
  `;

  const svgEl = container.querySelector('svg');
  const hitOverlay = container.querySelector<SVGRectElement>('#chartHitOverlay');
  const crossV = container.querySelector<SVGLineElement>('#chartCrosshairV');
  const crossH = container.querySelector<SVGLineElement>('#chartCrosshairH');
  const activeDot = container.querySelector<SVGCircleElement>('#chartActiveDot');

  if (!svgEl || !hitOverlay || !crossV || !crossH || !activeDot) return;

  const updateHover = (clientX: number): void => {
    const rect = svgEl.getBoundingClientRect();
    const scaleX = width / rect.width;
    const svgX = (clientX - rect.left) * scaleX;
    const clampedX = Math.max(pad.left, Math.min(pad.left + plotW, svgX));
    const ratio = plotW > 0 ? (clampedX - pad.left) / plotW : 0;
    const index = Math.min(series.length - 1, Math.max(0, Math.round(ratio * (series.length - 1))));
    const pt = series[index]!;

    const cx = getX(index);
    const cy = getY(pt.close);

    crossV.setAttribute('x1', cx.toFixed(2));
    crossV.setAttribute('x2', cx.toFixed(2));
    crossV.setAttribute('visibility', 'visible');

    crossH.setAttribute('y1', cy.toFixed(2));
    crossH.setAttribute('y2', cy.toFixed(2));
    crossH.setAttribute('visibility', 'visible');

    activeDot.setAttribute('cx', cx.toFixed(2));
    activeDot.setAttribute('cy', cy.toFixed(2));
    activeDot.setAttribute('visibility', 'visible');

    const deltaClass = pt.change >= 0 ? 'pos' : 'neg';
    tooltipEl.innerHTML = `
      <div class="tt-header">
        <span class="tt-date">${escapeHtml(pt.date)}</span>
        <span class="tt-badge ${deltaClass}">${escapeHtml(formatSignedPercent(pt.changePercent))}</span>
      </div>
      <div class="tt-grid">
        <div><span>Close:</span> <strong>${escapeHtml(formatPrice(pt.close, options.currency))}</strong></div>
        <div><span>Open:</span> <strong>${escapeHtml(formatPrice(pt.open, options.currency))}</strong></div>
        <div><span>High:</span> <strong>${escapeHtml(formatPrice(pt.high, options.currency))}</strong></div>
        <div><span>Low:</span> <strong>${escapeHtml(formatPrice(pt.low, options.currency))}</strong></div>
        ${
          pt.sma20 !== null && options.showSma20
            ? `<div class="tt-sma20"><span>SMA 20:</span> <strong>${escapeHtml(formatPrice(pt.sma20, options.currency))}</strong></div>`
            : ''
        }
        ${
          pt.sma50 !== null && options.showSma50
            ? `<div class="tt-sma50"><span>SMA 50:</span> <strong>${escapeHtml(formatPrice(pt.sma50, options.currency))}</strong></div>`
            : ''
        }
        ${
          pt.sma200 !== null && options.showSma200
            ? `<div class="tt-sma200"><span>SMA 200:</span> <strong>${escapeHtml(formatPrice(pt.sma200, options.currency))}</strong></div>`
            : ''
        }
      </div>
    `;
    tooltipEl.hidden = false;
  };

  hitOverlay.addEventListener('mousemove', (ev: MouseEvent) => {
    updateHover(ev.clientX);
  });

  hitOverlay.addEventListener('mouseleave', () => {
    crossV.setAttribute('visibility', 'hidden');
    crossH.setAttribute('visibility', 'hidden');
    activeDot.setAttribute('visibility', 'hidden');
    tooltipEl.hidden = true;
  });
}
