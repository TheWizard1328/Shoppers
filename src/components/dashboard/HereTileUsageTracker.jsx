import { useEffect, useRef } from "react";
import { base44 } from "@/api/base44Client";

const getTodayTimestamp = () => new Date().toISOString();

export default function HereTileUsageTracker({ mapStyle, apiKeyReady }) {
  const processedKeysRef = useRef(new Set());
  const pendingCountRef = useRef(0);
  const flushTimeoutRef = useRef(null);

  useEffect(() => {
    if (!apiKeyReady) return;

    const flushLogs = async () => {
      const count = pendingCountRef.current;
      pendingCountRef.current = 0;
      flushTimeoutRef.current = null;
      if (!count) return;

      await base44.entities.GoogleAPILog.create({
        timestamp: getTodayTimestamp(),
        api_type: "Map Tiles (HERE)",
        purpose: `Cached ${count} new HERE map tile${count === 1 ? "" : "s"}`,
        function_name: "HereTileUsageTracker",
        metadata: {
          provider: "HERE",
          source: "service_worker_cache",
          map_style: mapStyle || "explore",
          call_count: count
        }
      });
    };

    const scheduleFlush = () => {
      if (flushTimeoutRef.current) return;
      flushTimeoutRef.current = window.setTimeout(() => {
        flushLogs().catch(() => {});
      }, 800);
    };

    const handleMessage = (event) => {
      const data = event?.data;
      if (!data || data.type !== "HERE_TILE_CACHED") return;
      const cacheKey = data.cacheKey || data.url;
      if (!cacheKey || processedKeysRef.current.has(cacheKey)) return;
      processedKeysRef.current.add(cacheKey);
      pendingCountRef.current += 1;
      scheduleFlush();
    };

    navigator.serviceWorker?.addEventListener("message", handleMessage);

    return () => {
      navigator.serviceWorker?.removeEventListener("message", handleMessage);
      if (flushTimeoutRef.current) {
        window.clearTimeout(flushTimeoutRef.current);
        flushTimeoutRef.current = null;
      }
      flushLogs().catch(() => {});
    };
  }, [apiKeyReady, mapStyle]);

  return null;
}