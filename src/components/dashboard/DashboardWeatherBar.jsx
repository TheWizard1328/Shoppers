/**
 * DashboardWeatherBar — minimal semi-transparent vertical thermometer pinned
 * to the far-left edge of the dashboard (owner spec, Sep 27 2026 mock-ups).
 *
 * Design (owner spec v2):
 *   • Slim frosted tube (~12px) on the far-left edge, floating in the open map
 *     space between the stats panel (top) and the FABs / multi-select checkbox
 *     strip (bottom). Bottom anchor uses the SAME baseline as FABControls /
 *     DashboardBulkEditControls (stopCardsBaseHeight + bottom-nav-height + 10)
 *     so the bar always starts just above the multi-select checkbox. Top anchor
 *     uses the stats panel BASE height so panel/card expansion never moves it.
 *   • Scale: top = projected high + 10, bottom = projected low - 10.
 *   • The tube itself fades darker orange (at the projected high) to darker
 *     blue (at the projected low), with the orange→blue crossing pinned to the
 *     0 °C position on the bar.
 *   • Thin marker lines at the projected high and low with the temps labelled
 *     next to them, and a current-temp marker line + badge (condition icon +
 *     temp) aligned EXACTLY at the current temp position on the scale.
 *   • pointer-events: none — purely informational, never blocks the map or UI.
 *
 * NOTE on layout math: the whole bar box gets an EXPLICIT pixel height (computed
 * in JS from the viewport height minus the top/bottom anchors) instead of
 * relying on the browser to derive height implicitly from top+bottom-only
 * absolute positioning. Child marker offsets are plain pixel values derived
 * from that same explicit height (not CSS percentages of an implicit parent
 * height). Some Android WebView builds render top+bottom-only absolute boxes
 * (and percentage-of-implicit-height children) unreliably — explicit pixel
 * math avoids that class of bug entirely. No backdrop-filter (same reason —
 * inconsistent support in older WebViews); plain semi-transparent colors only.
 *
 * Data: shared AppSettings 'dashboard_weather' record (see
 * dashboardWeatherSettings.js), refreshed via 'appSettingsUpdated' WebSocket
 * events from the 5-minute dashboardWeatherPoll workflow.
 * City selection: the user's own city first; a single stored city still shows;
 * otherwise hide (never show the wrong city's weather).
 */
import { memo, useEffect, useRef, useState } from 'react';
import { getDashboardWeather } from '@/components/utils/dashboardWeatherSettings';

const WEATHER_ICONS = Object.freeze({
  sun: '☀️', partly: '🌤️', cloud: '☁️', fog: '🌫️',
  rain: '🌧️', snow: '🌨️', storm: '⛈️',
});

// Darker orange (hot end) / darker blue (cold end) with the 0 °C crossing blend
const HOT_RGB = [194, 65, 12];    // #c2410c
const COLD_RGB = [30, 58, 138];   // #1e3a8a

function rgba(rgb, a) { return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`; }
function blendRgb(a, b, t) {
  return [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t));
}

function pickCityWeather(weather, currentUser) {
  if (!weather?.cities || typeof weather.cities !== 'object') return null;
  const ownId = (Array.isArray(currentUser?.city_ids) && currentUser.city_ids[0]) || currentUser?.city_id || null;
  if (ownId && weather.cities[ownId]) return weather.cities[ownId];
  const entries = Object.values(weather.cities).filter((e) => e && Number.isFinite(Number(e.temp)));
  if (entries.length === 1) return entries[0];
  return null; // ambiguous — hide rather than show a wrong-city reading
}

function DashboardWeatherBar({ currentUser, statsContainerBaseHeight, stopCardsBaseHeight, immersiveHidden }) {
  const [entry, setEntry] = useState(null);
  const [vh, setVh] = useState(typeof window !== 'undefined' ? window.innerHeight : 800);
  const userRef = useRef(currentUser);
  userRef.current = currentUser;

  useEffect(() => {
    let alive = true;
    const load = (force) =>
      getDashboardWeather({ force })
        .then((w) => { if (alive) setEntry(pickCityWeather(w, userRef.current)); })
        .catch(() => {});
    load(false);
    // Poll pushes land as AppSettings entity writes → realtimeSync dispatches
    // this event on every subscribed device — force a fresh read each time.
    const onSettings = () => load(true);
    window.addEventListener('appSettingsUpdated', onSettings);
    const onResize = () => setVh(window.innerHeight);
    window.addEventListener('resize', onResize);
    return () => {
      alive = false;
      window.removeEventListener('appSettingsUpdated', onSettings);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  if (immersiveHidden || !entry || !Number.isFinite(Number(entry.temp))) return null;

  const temp = Number(entry.temp);
  const high = Number.isFinite(Number(entry.high)) ? Number(entry.high) : temp + 5;
  const low = Number.isFinite(Number(entry.low)) ? Number(entry.low) : temp - 5;
  const scaleTop = high + 10;   // upper limit = projected high + 10
  const scaleBottom = low - 10; // lower limit = projected low - 10
  const span = Math.max(1, scaleTop - scaleBottom);
  const frac = (v) => Math.min(0.98, Math.max(0.02, (v - scaleBottom) / span));

  // Bottom anchor — identical baseline to FABControls / bulk-edit pill so the
  // bar always starts just above the multi-select checkbox row.
  let bottomNavHeight = 0;
  try {
    bottomNavHeight = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--bottom-nav-height') || '0', 10) || 0;
  } catch { /* default 0 */ }
  const topAnchor = (Number(statsContainerBaseHeight) || 0) + 12;
  const bottomAnchor = (Number(stopCardsBaseHeight) || 0) + bottomNavHeight + 10;
  const barHeight = vh - topAnchor - bottomAnchor;
  if (barHeight < 150) return null; // no room — hide instead of cluttering

  // Pixel offsets from the BOTTOM of the (explicit-height) bar box.
  const yLow = Math.round(frac(low) * barHeight);
  const yHigh = Math.round(frac(high) * barHeight);
  const yTemp = Math.round(frac(temp) * barHeight);
  const yZero = frac(0) * barHeight;

  // Tube gradient (as fractions of the tube's own height, top→bottom in CSS
  // gradient terms means we build "to top" stops using bottom-relative fractions).
  const pLow = (yLow / barHeight) * 100;
  const pHigh = (yHigh / barHeight) * 100;
  const pZero = (yZero / barHeight) * 100;
  const stops = [`0% ${rgba(COLD_RGB, 0.9)}`, `${pLow.toFixed(1)}% ${rgba(COLD_RGB, 0.9)}`];
  if (pZero > pLow && pZero < pHigh) stops.push(`${pZero.toFixed(1)}% ${rgba(blendRgb(COLD_RGB, HOT_RGB, 0.5), 0.9)}`);
  stops.push(`${pHigh.toFixed(1)}% ${rgba(HOT_RGB, 0.9)}`, `100% ${rgba(HOT_RGB, 0.9)}`);
  const tubeGradient = `linear-gradient(to top, ${stops.join(', ')})`;

  const icon = WEATHER_ICONS[entry.icon] || '☁️';

  const markerStyle = (yPx) => ({
    position: 'absolute',
    bottom: `${yPx}px`,
    left: 0,
    display: 'flex',
    alignItems: 'center',
    gap: 4,
  });
  const lineStyle = { width: 12, height: 2, background: 'rgba(248,250,252,0.95)', borderRadius: 2, boxShadow: '0 0 2px rgba(0,0,0,0.7)' };
  const labelStyle = {
    fontSize: 9, lineHeight: '10px', fontWeight: 700,
    color: 'rgba(248,250,252,0.98)', textShadow: '0 1px 2px rgba(0,0,0,0.95)',
    whiteSpace: 'nowrap',
  };

  return (
    <div
      data-testid="dashboard-weather-bar"
      aria-label={`Current temperature ${temp} degrees, high ${high}, low ${low}`}
      className="pointer-events-none absolute z-[220]"
      style={{ left: 6, top: topAnchor, height: barHeight, width: 60 }}
    >
      {/* Frosted tube — the gradient IS the scale (blue low → 0 °C → orange high) */}
      <div
        style={{
          position: 'absolute', top: 0, bottom: 0, left: 0, width: 12,
          borderRadius: 999,
          background: tubeGradient,
          border: '1px solid rgba(148,163,184,0.4)',
          boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
        }}
      />

      {/* Projected HIGH line + temp */}
      <div style={markerStyle(yHigh)}>
        <div style={lineStyle} />
        <span style={labelStyle}>{`${high}°`}</span>
      </div>

      {/* Projected LOW line + temp */}
      <div style={markerStyle(yLow)}>
        <div style={lineStyle} />
        <span style={labelStyle}>{`${low}°`}</span>
      </div>

      {/* Current temp — line + badge aligned exactly at the current temp position */}
      <div style={markerStyle(yTemp)}>
        <div style={{ width: 12, height: 2, background: '#ffffff', borderRadius: 2, boxShadow: '0 0 3px rgba(0,0,0,0.9)' }} />
        <span
          style={{
            display: 'flex', alignItems: 'center', gap: 3,
            padding: '2px 6px', borderRadius: 8,
            background: 'rgba(15,23,42,0.85)',
            border: '1px solid rgba(148,163,184,0.5)',
            fontSize: 11, fontWeight: 700, color: '#f8fafc',
            textShadow: '0 1px 2px rgba(0,0,0,0.9)',
            whiteSpace: 'nowrap',
            boxShadow: '0 2px 6px rgba(0,0,0,0.4)',
          }}
        >
          <span style={{ fontSize: 11, lineHeight: 1 }}>{icon}</span>
          {`${temp}°`}
        </span>
      </div>
    </div>
  );
}

export default memo(DashboardWeatherBar);
