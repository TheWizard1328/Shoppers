/**
 * WinterModeBanner — slim dismissible banner shown while Winter Mode is on.
 *
 * Winter Mode (AppSettings → refresh_intervals.setting_value.winter_mode)
 * pads ETAs and widens the arrival / proximity-snap GPS-drift tolerances.
 * The banner makes that visible to drivers & admins so padded ETAs don't look
 * like a bug. Dismissed per browser session (sessionStorage).
 */
import { memo, useEffect, useState } from 'react';
import { getWinterModeSettings } from '@/components/utils/winterModeSettings';

const DISMISS_KEY = 'rxdeliver_winter_banner_dismissed';

function WinterModeBanner() {
  const [winter, setWinter] = useState(null);
  const [dismissed, setDismissed] = useState(() => {
    try { return sessionStorage.getItem(DISMISS_KEY) === 'true'; } catch { return false; }
  });

  useEffect(() => {
    let alive = true;
    const load = () => getWinterModeSettings({ force: false }).then((w) => { if (alive) setWinter(w); }).catch(() => {});
    load();
    const onSettings = () => getWinterModeSettings({ force: true }).then((w) => { if (alive) setWinter(w); }).catch(() => {});
    window.addEventListener('appSettingsUpdated', onSettings);
    return () => { alive = false; window.removeEventListener('appSettingsUpdated', onSettings); };
  }, []);

  if (!winter?.enabled || dismissed) return null;

  const padPct = Math.round((winter.eta_factor - 1) * 100);

  return (
    <div
      data-testid="winter-mode-banner"
      className="mx-auto flex items-center gap-2 rounded-lg border border-blue-300/60 bg-blue-50/90 dark:bg-slate-800/90 px-3 py-1.5 text-xs text-blue-800 dark:text-blue-200 shadow-sm"
      style={{ width: 'min(95vw, 370px)' }}
    >
      <span aria-hidden>❄️</span>
      <span className="flex-1 leading-tight">
        <span className='font-semibold'>Winter mode active</span> — ETAs padded {padPct}% &amp; arrival radius {winter.arrival_radius_m}m for GPS drift
      </span>
      <button
        type="button"
        aria-label="Dismiss winter mode banner"
        className="ml-1 shrink-0 rounded px-1 text-blue-400 hover:text-blue-600 dark:hover:text-blue-200"
        onClick={() => {
          try { sessionStorage.setItem(DISMISS_KEY, 'true'); } catch { /* best-effort */ }
          setDismissed(true);
        }}
      >
        ✕
      </button>
    </div>
  );
}

export default memo(WinterModeBanner);
