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
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { getDashboardWeather, pollDashboardWeatherNow } from '@/components/utils/dashboardWeatherSettings';

const WEATHER_ICONS = Object.freeze({
  sun: '☀️', partly: '🌤️', cloud: '☁️', fog: '🌫️',
  rain: '🌧️', snow: '🌨️', storm: '⛈️',
});

// Night variants (owner request, Sep 28): moon instead of sun, and the other
// weather types keep their icon alongside the moon (moon+cloud for partly
// cloudy nights, etc.). Full-cover conditions look the same day or night.
const WEATHER_ICONS_NIGHT = Object.freeze({
  sun: '🌙', partly: '🌙☁️', cloud: '☁️', fog: '🌫️',
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

function DashboardWeatherBar({
  currentUser, statsContainerBaseHeight, stopCardsBaseHeight, immersiveHidden,
  statsContainerRef, horizontalStopCardsRef, mapAreaRef,
}) {
  const [entry, setEntry] = useState(null);
  const userRef = useRef(currentUser);
  userRef.current = currentUser;

  // ── EMPIRICAL GEOMETRY ────────────────────────────────────────────────────
  // Earlier formula-based anchors (window.innerHeight minus prop heights)
  // kept drifting from reality: window.innerHeight includes UI outside the
  // map area, and the base-height props stay frozen while a stop card is
  // expanded. Instead we measure the real elements every time anything can
  // move:
  //   • bar height  = mapArea (this bar's positioned parent) clientHeight
  //   • top anchor  = live stats panel bottom (offsetTop + offsetHeight)
  //   • bottom edge = just ABOVE the bulk-select checkbox row
  //     ([data-bulk-select-toggle]); fallback: 10px above the stop-cards strip
  // The bar never computes from window.innerHeight and never reads frozen
  // base-height props except as a first-paint fallback.
  const [geo, setGeo] = useState({ parentH: 0, top: 0, bottomGap: 0 });

  const measureGeo = useCallback(() => {
    const parent = mapAreaRef?.current;
    if (!parent) return;
    const parentRect = parent.getBoundingClientRect();

    // Top: live stats panel bottom
    let top = 0;
    const statsEl = statsContainerRef?.current;
    if (statsEl) {
      top = Math.max(0, statsEl.getBoundingClientRect().bottom - parentRect.top) + 6;
    }
    if (!top) top = (Number(statsContainerBaseHeight) || 0) + 6;

    // Bottom: just above the bulk-select checkbox row; fall back to the
    // stop-cards strip top, then to the base-height formula.
    let bottomGap = 0;
    const cb = document.querySelector('[data-bulk-select-toggle]');
    const cbRect = cb && cb.offsetParent !== null ? cb.getBoundingClientRect() : null;
    const strip = horizontalStopCardsRef?.current;
    const stripRect = strip && strip.offsetParent !== null ? strip.getBoundingClientRect() : null;
    if (cbRect) {
      bottomGap = Math.max(0, parentRect.bottom - cbRect.top) + 4;
    } else if (stripRect) {
      bottomGap = Math.max(0, parentRect.bottom - stripRect.top) + 5;
    } else {
      let navH = 0;
      try { navH = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--bottom-nav-height') || '0', 10) || 0; } catch { /* noop */ }
      bottomGap = (Number(stopCardsBaseHeight) || 0) + navH + 5;
    }

    setGeo({ parentH: parent.clientHeight || 0, top, bottomGap });
  }, [mapAreaRef, statsContainerRef, horizontalStopCardsRef, statsContainerBaseHeight, stopCardsBaseHeight]);

  useLayoutEffect(() => {
    measureGeo();
    const observers = [];
    const obs = (el) => { if (!el) return; const ro = new ResizeObserver(() => measureGeo()); ro.observe(el); observers.push(ro); };
    obs(mapAreaRef?.current);
    obs(statsContainerRef?.current);
    obs(horizontalStopCardsRef?.current);
    const onResize = () => measureGeo();
    window.addEventListener('resize', onResize);
    return () => {
      observers.forEach((ro) => ro.disconnect());
      window.removeEventListener('resize', onResize);
    };
  }, [measureGeo, entry, immersiveHidden]);

  useEffect(() => {
    let alive = true;
    const load = (force) =>
      getDashboardWeather({ force })
        .then((w) => { if (alive) setEntry(pickCityWeather(w, userRef.current)); })
        .catch(() => {});
    load(false);
    // Poll pushes land as AppSettings entity writes → realtimeSync dispatches
    // this event on every subscribed device — force a fresh read each time.
    const onSettings = () => { load(true); measureGeo(); };
    window.addEventListener('appSettingsUpdated', onSettings);
    // While the dashboard is open, POLL every 5 minutes (owner request, Sep 28)
    // — not just re-read. The poll runs even with no drivers on duty (backend
    // fetches ALL cities) and pushes fresh data to every open device. Then a
    // local re-read covers the case where this device misses the broadcast.
    const interval = setInterval(() => {
      pollDashboardWeatherNow().catch(() => {});
      load(true);
      measureGeo();
    }, 5 * 60 * 1000);
    return () => {
      alive = false;
      window.removeEventListener('appSettingsUpdated', onSettings);
      clearInterval(interval);
    };
  }, []);

  if (!entry || !Number.isFinite(Number(entry.temp))) return null;
  // Immersive mode (owner request, Sep 28): the bar STAYS visible — the badge
  // is replaced by the bare weather symbol sitting on the tube at the current
  // temp position (see the badge render below).

  const temp = Number(entry.temp);
  // Decimal temp for badge alignment (owner request, Sep 28): the badge flows
  // smoothly with sub-degree changes instead of jumping whole degrees.
  const tempPrecise = Number.isFinite(Number(entry.temp_precise)) ? Number(entry.temp_precise) : temp;
  const high = Number.isFinite(Number(entry.high)) ? Number(entry.high) : temp + 5;
  const low = Number.isFinite(Number(entry.low)) ? Number(entry.low) : temp - 5;
  // Scale limits (owner spec, Sep 27 v4): 2° above the top marker / 2° below
  // the bottom one — but if the CURRENT temp sits outside the projected
  // high..low band, the scale stretches to 2° past the current temp instead.
  // The projected high/low markers always stay visible.
  const scaleTop = Math.max(high, tempPrecise) + 2;
  const scaleBottom = Math.min(low, tempPrecise) - 2;
  const span = Math.max(1, scaleTop - scaleBottom);
  const frac = (v) => Math.min(0.98, Math.max(0.02, (v - scaleBottom) / span));

  const topAnchor = geo.top || (Number(statsContainerBaseHeight) || 0) + 12;
  const barHeight = geo.parentH - topAnchor - geo.bottomGap;
  if (barHeight < 150) return null; // no room — hide instead of cluttering

  // Pixel offsets from the BOTTOM of the (explicit-height) bar box.
  const yLow = Math.round(frac(low) * barHeight);
  const yHigh = Math.round(frac(high) * barHeight);
  const yTemp = Math.round(frac(tempPrecise) * barHeight);
  const yZero = frac(0) * barHeight;

  // ── Colored fill: ONLY the segment between the projected LOW and HIGH ──
  // (owner spec, Sep 27: the +10/-10° buffer zones above/below stay empty
  // frosted track). The gradient is temperature-anchored: the orange↔blue
  // switch is pinned to the 0 °C position when 0 falls strictly inside the
  // low..high range, with a distinct white 0° line drawn there.
  const MID_RGB = blendRgb(COLD_RGB, HOT_RGB, 0.5);
  const colorFor = (t) => (t >= 0
    ? blendRgb(MID_RGB, HOT_RGB, Math.min(1, high > 0 ? t / high : 1))
    : blendRgb(MID_RGB, COLD_RGB, Math.min(1, low < 0 ? t / low : 1)));
  const fillTopPx = barHeight - yHigh;           // px from bar top down to the HIGH line
  const fillHeight = Math.max(0, yHigh - yLow);  // colored segment height
  const pZeroInFill = fillHeight > 0 ? ((yZero - yLow) / fillHeight) * 100 : 50;
  // NOTE canonical stop order — "<color> <position>" (NOT "<position> <color>"):
  // the reversed order parses on desktop Chrome but the fleet's Android WebView
  // rejects it and silently drops the whole gradient, leaving the fallback blue.
  const stops = [`${rgba(colorFor(low), 0.92)} 0%`];
  if (low < 0 && high > 0 && pZeroInFill > 1 && pZeroInFill < 99) stops.push(`${rgba(MID_RGB, 0.92)} ${pZeroInFill.toFixed(1)}%`);
  stops.push(`${rgba(colorFor(high), 0.92)} 100%`);
  const fillGradient = `linear-gradient(to top, ${stops.join(', ')})`;

  // Day vs night icon set — is_day comes from the poll (open-meteo real flag,
  // Edmonton-hour approximation on fallback providers).
  const iconSet = entry.is_day === false ? WEATHER_ICONS_NIGHT : WEATHER_ICONS;
  const icon = iconSet[entry.icon] || '☁️';

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
      {/* Frosted TRACK — full scale incl. the +10/-10° buffer zones; the zones
          above the high and below the low stay empty (translucent track only).
          EXPLICIT pixel height everywhere: some Android WebView builds on this
          fleet render top+bottom-only absolute boxes at zero height. */}
      <div
        style={{
          position: 'absolute', top: 0, left: 0, width: 12, height: barHeight,
          borderRadius: 999,
          background: 'rgba(255,255,255,0.10)',
          border: '1.5px solid rgba(15,23,42,0.55)',
          boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
        }}
      />

      {/* Colored FILL — only between the projected low and high; gradient
          switches orange↔blue at 0 °C. backgroundColor = mid fallback. */}
      {fillHeight >= 2 && (
        <div
          style={{
            position: 'absolute', top: fillTopPx, left: 0, width: 12, height: fillHeight,
            borderRadius: 999,
            backgroundColor: rgba(MID_RGB, 0.92),
            backgroundImage: fillGradient,
            boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
          }}
        />
      )}

      {/* Integer-degree dots (owner request, Sep 28): one small dot per whole
          degree position on the scale — no numbers. Covers the FULL scale
          INCLUDING the buffer zones above the high and below the low; the
          projected high/low positions are skipped (their rotated labels
          already mark those spots). Rendered after the fill so they're
          visible on both the colored segment and the empty frosted track. */}
      {(() => {
        const dots = [];
        const first = Math.ceil(scaleBottom);
        const last = Math.floor(scaleTop);
        for (let v = first; v <= last; v++) {
          if (v === high || v === low) continue;
          const yDot = Math.round(frac(v) * barHeight);
          dots.push(
            <div
              key={v}
              style={{
                position: 'absolute', bottom: yDot - 1.5, left: 4.5,
                width: 3, height: 3, borderRadius: 999,
                background: 'rgba(255,255,255,0.92)',
                boxShadow: '0 0 0 1px rgba(15,23,42,0.45), 0 1px 2px rgba(0,0,0,0.5)',
              }}
            />
          );
        }
        return dots;
      })()}

      {/* Projected HIGH — rotated 90° CCW, on the bar just below the high position */}
      <div style={{ position: 'absolute', bottom: `${Math.max(0, yHigh - 14)}px`, left: 0, width: 12, display: 'flex', justifyContent: 'center' }}>
        <span style={{ ...labelStyle, display: 'inline-block', transform: 'rotate(-90deg)' }}>{`${high}°`}</span>
      </div>

      {/* Projected LOW — rotated 90° CCW, on the bar just above the low position */}
      <div style={{ position: 'absolute', bottom: `${yLow + 3}px`, left: 0, width: 12, display: 'flex', justifyContent: 'center' }}>
        <span style={{ ...labelStyle, display: 'inline-block', transform: 'rotate(-90deg)' }}>{`${low}°`}</span>
      </div>

      {/* Current temp — immersive mode (owner request, Sep 28): the badge
          disappears entirely; ONLY the weather symbol shows, sitting directly
          ON the tube at the exact current temp position (centered on it),
          sized to cover the tube width with a dark outline for readability
          over the gradient fill. */}
      {immersiveHidden ? (
        <div
          style={{
            position: 'absolute', bottom: `${yTemp}px`, left: -3, width: 18,
            display: 'flex', justifyContent: 'center', alignItems: 'center',
            transform: 'translateY(50%)',
            fontSize: 11, lineHeight: 1,
            textShadow: '0 0 2px rgba(0,0,0,0.9), 0 1px 2px rgba(0,0,0,0.9)',
          }}
        >
          <span style={{ fontSize: 11, lineHeight: 1 }}>{icon}</span>
        </div>
      ) : (
      <div style={{ position: 'absolute', bottom: `${yTemp}px`, left: 16, display: 'flex', alignItems: 'center', transform: 'translateY(50%)' }}>
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
      )}
    </div>
  );
}

export default memo(DashboardWeatherBar);
