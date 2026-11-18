import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Lock } from 'lucide-react';

// Drivers' routes lock at 9:00 PM local (owner rule Nov 17 2026). A finished route
// stays editable until that hour, so this banner tells the driver how long they
// have, then flips to a locked notice once the hour passes.
const ROUTE_LOCK_HOUR_LOCAL = 21;
const FINISHED_STATUSES = ['completed', 'failed', 'cancelled'];
const ACTIVE_STATUSES = ['in_transit', 'en_route'];

const pad = (n) => String(n).padStart(2, '0');
const localDateString = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export default function RouteLockBanner({ deliveries, currentUser, isDriver, isAdmin, isDispatcher }) {
  const [now, setNow] = useState(() => new Date());

  // Re-render every 30s so the countdown and the 9:00 PM flip stay live without a reload.
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(t);
  }, []);

  const state = useMemo(() => {
    // DRIVER-ONLY NOTICE (owner spec Nov 18 2026): admins and dispatchers never see
    // this. A driver only ever sees it for their OWN route, never a viewed driver's.
    if (!isDriver || isAdmin || isDispatcher) return null;
    const selfIds = new Set([currentUser?.id, currentUser?.user_id].filter(Boolean).map(String));
    const rows = (Array.isArray(deliveries) ? deliveries.filter(Boolean) : [])
      .filter((d) => !d?.driver_id || selfIds.size === 0 || selfIds.has(String(d.driver_id)));
    if (rows.length === 0) return null;
    // Only the route the driver is actually on: same day as the latest stop.
    const latestDate = rows.map((d) => String(d.delivery_date || '')).sort().pop();
    const dayRows = rows.filter((d) => String(d.delivery_date || '') === latestDate);
    if (dayRows.length === 0) return null;
    if (dayRows.some((d) => ACTIVE_STATUSES.includes(d.status))) return null; // still driving
    if (!dayRows.some((d) => FINISHED_STATUSES.includes(d.status))) return null; // not started today

    const lockAt = new Date(now);
    lockAt.setHours(ROUTE_LOCK_HOUR_LOCAL, 0, 0, 0);
    const isPastDate = String(latestDate) < localDateString(now);
    const locked = isPastDate || now.getTime() >= lockAt.getTime();
    const minutesLeft = Math.max(0, Math.round((lockAt.getTime() - now.getTime()) / 60000));
    return { locked, minutesLeft, lockAt };
  }, [deliveries, now, isDriver, isAdmin, isDispatcher, currentUser?.id, currentUser?.user_id]);

  if (!state) return null;

  const lockLabel = `${ROUTE_LOCK_HOUR_LOCAL - 12}:00 PM`;

  if (state.locked) {
    return (
      <div className="pointer-events-none mb-1 flex w-full justify-center px-2">
        <div className="pointer-events-auto inline-flex w-auto max-w-[calc(100vw-2rem)] items-center gap-1.5 rounded-full border border-rose-300 bg-rose-50 px-3 py-1.5 text-[12px] font-semibold leading-tight text-rose-900 shadow-sm dark:border-rose-800 dark:bg-rose-950/70 dark:text-rose-100">
          <Lock className="h-3.5 w-3.5 shrink-0" />
          <span>Route locked.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="pointer-events-none mb-1 flex w-full justify-center px-2">
      <div className="pointer-events-auto inline-flex w-auto max-w-[calc(100vw-2rem)] items-center gap-1.5 rounded-full border border-amber-300 bg-amber-50 px-3 py-1.5 text-[12px] leading-tight text-amber-900 shadow-sm dark:border-amber-800 dark:bg-amber-950/70 dark:text-amber-100">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        <span>
          <span className="font-semibold">Route editing locks at {lockLabel}.</span>{' '}
          {state.minutesLeft > 0
            ? `Make any edits to your stops before then (${state.minutesLeft} min left).`
            : 'Make any edits to your stops before then.'}
        </span>
      </div>
    </div>
  );
}
