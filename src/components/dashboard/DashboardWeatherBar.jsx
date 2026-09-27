/**
 * DashboardWeatherBar — minimal semi-transparent vertical thermometer pinned
 * to the far-left edge of the dashboard (owner spec, Sep 27 2026 mock-ups).
 *
 * Design (per approved mock-up + red-line placement):
 *   • Slim frosted tube (~12px wide) on the far-left edge only, floating in
 *     the open map space between the stats panel (top) and the bulk-edit
 *     checkbox / stop cards strip (bottom).
 *   • Anchored with BASE heights (statsContainerBaseHeight / stopCardsBaseHeight)
 *     so expanding the stats card panel or a stop card does NOT move the bar.
 *   • Scale: top = projected high + 10, bottom = projected low - 10.
 *   • Mercury fill: warm amber→red for positive temps, blue for negative.
 *   • Tiny current-temp badge at the mercury level with a condition icon
 *     (sun / partly / cloud / fog / rain / snow / storm).
 *   • Micro "H" / "L" labels at the tube ends.
 *   • pointer-events: none — purely informational, never blocks the map or UI.
 *
 * Data: shared AppSettings 'dashboard_weather' record (see
 * dashboardWeatherSettings.js). Updates arrive via the existing AppSettings
 * WebSocket subscription → 'appSettingsUpdated' → forced re-read.
 * City selection: the user's own city first; if absent, a single stored city
 * still shows; multiple stored cities with no own-city match hides the bar
 * (never show the wrong city's weather).
 */
import { memo, useEffect, useRef, useState } from 'react';
import { getDashboardWeather } from '@/components/utils/dashboardWeatherSettings';

const WEATHER_ICONS = Object.freeze({
  sun: '☀️', partly: '🌤️', cloud: '☁️', fog: '🌫️',
  rain: '🌧️', snow: '🌨️', storm: '⛈️',
});

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
  const scaleTop = Math.max(high, temp) + 10;   // upper limit = high + 10
  const scaleBottom = Math.min(low, temp) - 10; // lower limit = low - 10
  const span = Math.max(1, scaleTop - scaleBottom);
  const pos = Math.min(1, Math.max(0.02, (temp - scaleBottom) / span));
  const warm = temp >= 0;

  const topAnchor = (Number(statsContainerBaseHeight) || 0) + 12;
  const bottomAnchor = (Number(stopCardsBaseHeight) || 0) + 14;
  const available = vh - topAnchor - bottomAnchor;
  if (available < 150) return null; // no room — hide instead of cluttering

  const mercuryColor = warm
    ? 'linear-gradient(to top, rgba(251,146,60,0.85), rgba(239,68,68,0.95))'
    : 'linear-gradient(to top, rgba(147,197,253,0.85), rgba(59,130,246,0.95))';
  const icon = WEATHER_ICONS[entry.icon] || '☁️';

  return (
    <div
      data-testid="dashboard-weather-bar"
      aria-label={`Current temperature ${temp} degrees, high ${high}, low ${low}`}
      className="pointer-events-none absolute z-[220]"
      style={{ left: 6, top: topAnchor, bottom: bottomAnchor }}
    >
      {/* Micro high label */}
      <div
        style={{
          position: 'absolute', top: -4, left: 16,
          fontSize: 9, lineHeight: '10px', fontWeight: 600,
          color: 'rgba(248,250,252,0.85)', textShadow: '0 1px 2px rgba(0,0,0,0.8)',
          whiteSpace: 'nowrap',
        }}
      >
        {`H ${high}°`}
      </div>

      {/* Frosted tube */}
      <div
        style={{
          position: 'absolute', top: 10, bottom: 10, left: 0, width: 12,
          borderRadius: 999,
          background: 'rgba(15,23,42,0.45)',
          border: '1px solid rgba(148,163,184,0.35)',
          backdropFilter: 'blur(2px)', WebkitBackdropFilter: 'blur(2px)',
          boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
          overflow: 'hidden',
        }}
      >
        {/* Mercury fill */}
        <div
          style={{
            position: 'absolute', bottom: 0, left: 0, right: 0,
            height: `${Math.round(pos * 100)}%`,
            background: mercuryColor,
            borderRadius: 999,
          }}
        />
      </div>

      {/* Current temp badge at mercury level */}
      <div
        style={{
          position: 'absolute',
          bottom: `calc(${Math.round(pos * 100)}% * 0.82 + 10px)`,
          left: 16,
          display: 'flex', alignItems: 'center', gap: 3,
          padding: '2px 6px', borderRadius: 8,
          background: 'rgba(15,23,42,0.65)',
          border: '1px solid rgba(148,163,184,0.4)',
          backdropFilter: 'blur(2px)', WebkitBackdropFilter: 'blur(2px)',
          fontSize: 11, fontWeight: 700, color: '#f8fafc',
          textShadow: '0 1px 2px rgba(0,0,0,0.8)',
          whiteSpace: 'nowrap',
          boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
        }}
      >
        <span style={{ fontSize: 11, lineHeight: 1 }}>{icon}</span>
        {`${temp}°`}
      </div>

      {/* Micro low label */}
      <div
        style={{
          position: 'absolute', bottom: -4, left: 16,
          fontSize: 9, lineHeight: '10px', fontWeight: 600,
          color: 'rgba(248,250,252,0.85)', textShadow: '0 1px 2px rgba(0,0,0,0.8)',
          whiteSpace: 'nowrap',
        }}
      >
        {`L ${low}°`}
      </div>
    </div>
  );
}

export default memo(DashboardWeatherBar);
