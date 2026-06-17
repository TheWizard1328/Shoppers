import { useEffect, useRef } from "react";
import { base44 } from "@/api/base44Client";

const getTodayTimestamp = () => new Date().toISOString();

export default function HereTileUsageTracker({ mapStyle, apiKeyReady, currentUser }) {
  const pendingCountRef = useRef(0);
  const flushTimeoutRef = useRef(null);
  // Keep a ref to the latest currentUser so the flush closure always sees
  // the most up-to-date user even if it arrives after the effect ran
  const currentUserRef = useRef(currentUser);
  useEffect(() => { currentUserRef.current = currentUser; }, [currentUser]);

  useEffect(() => {
    if (!apiKeyReady) return;

    const flushLogs = async () => {
      const count = pendingCountRef.current;
      pendingCountRef.current = 0;
      flushTimeoutRef.current = null;
      if (!count) return;

      // Always read from ref so we get the latest user at flush time
      const user = currentUserRef.current;

      try {
        await base44.entities.GoogleAPILog.create({
          timestamp: getTodayTimestamp(),
          api_type: "Map Tiles (HERE)",
          purpose: `Fetched ${count} HERE map tile${count === 1 ? "" : "s"} from network`,
          function_name: "HereTileUsageTracker",
          user_id: user?.id || null,
          user_name: user?.user_name || user?.full_name || null,
          metadata: {
            provider: "HERE",
            source: "network_fetch",
            map_style: mapStyle || "explore",
            call_count: count
          }
        });
      } catch {
        // best-effort — don't break the map
      }
    };

    const scheduleFlush = () => {
      if (flushTimeoutRef.current) return;
      flushTimeoutRef.current = window.setTimeout(() => {
        flushLogs().catch(() => {});
      }, 4000); // batch up to 4s of tile fetches into one log entry
    };

    // Listen for network fetch events dispatched by hereTileCache.js fetchAndCache()
    const handleNetworkFetch = (event) => {
      const count = event?.detail?.count ?? 1;
      pendingCountRef.current += count;
      scheduleFlush();
    };

    window.addEventListener('hereTileNetworkFetch', handleNetworkFetch);

    return () => {
      window.removeEventListener('hereTileNetworkFetch', handleNetworkFetch);
      if (flushTimeoutRef.current) {
        window.clearTimeout(flushTimeoutRef.current);
        flushTimeoutRef.current = null;
      }
      flushLogs().catch(() => {});
    };
  }, [apiKeyReady, mapStyle]); // intentionally omit currentUser — we use the ref

  return null;
}