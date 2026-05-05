import { useEffect, useRef } from "react";
import { base44 } from "@/api/base44Client";

const getTodayTimestamp = () => new Date().toISOString();

export default function HereTileUsageTracker({ mapStyle, apiKeyReady }) {
  const processedKeysRef = useRef(new Set());
  const pendingCountRef = useRef(0);
  const flushTimeoutRef = useRef(null);
  const messageQueueRef = useRef([]);

  useEffect(() => {
    if (!apiKeyReady) return;
    if (typeof window !== 'undefined' && Array.isArray(window.__hereTileSwMessageQueue)) {
      messageQueueRef.current = [...window.__hereTileSwMessageQueue];
      window.__hereTileSwMessageQueue = [];
    }

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

    const processMessage = (data) => {
      if (!data || data.type !== "HERE_TILE_CACHED") return;
      const cacheKey = data.cacheKey || data.url;
      if (!cacheKey || processedKeysRef.current.has(cacheKey)) return;
      processedKeysRef.current.add(cacheKey);
      pendingCountRef.current += 1;
      scheduleFlush();
    };

    const handleMessage = (event) => {
      processMessage(event?.data);
    };

    messageQueueRef.current.forEach(processMessage);
    messageQueueRef.current = [];
    const handleWindowQueuedMessage = () => {
      if (typeof window === 'undefined' || !Array.isArray(window.__hereTileSwMessageQueue) || window.__hereTileSwMessageQueue.length === 0) return;
      const queuedMessages = [...window.__hereTileSwMessageQueue];
      window.__hereTileSwMessageQueue = [];
      queuedMessages.forEach(processMessage);
    };

    navigator.serviceWorker?.addEventListener("message", handleMessage);
    window.addEventListener('hereTileSwMessage', handleWindowQueuedMessage);

    return () => {
      navigator.serviceWorker?.removeEventListener("message", handleMessage);
      window.removeEventListener('hereTileSwMessage', handleWindowQueuedMessage);
      if (flushTimeoutRef.current) {
        window.clearTimeout(flushTimeoutRef.current);
        flushTimeoutRef.current = null;
      }
      flushLogs().catch(() => {});
    };
  }, [apiKeyReady, mapStyle]);

  return null;
}