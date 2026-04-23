import { useEffect, useMemo, useRef } from "react";
import { isMobileDevice } from "./deviceUtils";
import { syncDriverRoutePolylinesForDate } from "./hereRouting";

export default function useDriverRoutePolylineBackgroundSync({ targets = [], enabled = true, intervalMs = 30000, onSync }) {
  const isMobile = useMemo(() => isMobileDevice(), []);
  const isSyncingRef = useRef(false);

  const uniqueTargets = useMemo(() => {
    const map = new Map();
    (targets || []).forEach((target) => {
      if (!target?.driverId || !target?.deliveryDate) return;
      map.set(`${target.driverId}|${target.deliveryDate}`, target);
    });
    return Array.from(map.values());
  }, [targets]);

  useEffect(() => {
    if (!enabled || !isMobile || uniqueTargets.length === 0) return;

    let cancelled = false;

    const runSync = async () => {
      if (cancelled || isSyncingRef.current || document.visibilityState !== "visible") return;
      isSyncingRef.current = true;

      try {
        const results = await Promise.all(
          uniqueTargets.map((target) => syncDriverRoutePolylinesForDate(target.driverId, target.deliveryDate, true))
        );

        if (cancelled) return;
        const hasRows = results.some((rows) => Array.isArray(rows) && rows.length > 0);
        if (hasRows) onSync?.();
      } finally {
        isSyncingRef.current = false;
      }
    };

    const intervalId = window.setInterval(runSync, intervalMs);
    const onFocus = () => runSync();
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") runSync();
    };

    runSync();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [enabled, intervalMs, isMobile, uniqueTargets, onSync]);
}