import { useEffect, useRef } from "react";
import { base44 } from "@/api/base44Client";

const TILE_LOG_TTL_MS = 60000;

export default function HereTileUsageTracker({ mapStyle, apiKeyReady }) {
  const seenTileKeysRef = useRef(new Map());

  useEffect(() => {
    if (!apiKeyReady) return;

    const cleanup = () => {
      const now = Date.now();
      for (const [key, timestamp] of seenTileKeysRef.current.entries()) {
        if (now - timestamp > TILE_LOG_TTL_MS) {
          seenTileKeysRef.current.delete(key);
        }
      }
    };

    const handleTileLoad = (event) => {
      const src = event?.target?.src || "";
      if (!src.includes("maps.hereapi.com/v3/base/mc/")) return;

      const url = new URL(src);
      const pathKey = `${url.pathname}?style=${url.searchParams.get("style") || ""}`;
      cleanup();
      if (seenTileKeysRef.current.has(pathKey)) return;
      seenTileKeysRef.current.set(pathKey, Date.now());

      base44.entities.GoogleAPILog.create({
        timestamp: new Date().toISOString(),
        api_type: "Map Tiles (HERE)",
        purpose: `Loading HERE ${mapStyle} map tile`,
        function_name: "DeliveryMap",
        metadata: {
          api_provider: "here",
          call_count: 1,
          map_style: mapStyle || "explore",
          tile_path: url.pathname,
          tile_style: url.searchParams.get("style") || null
        }
      }).catch(() => null);
    };

    document.addEventListener("load", handleTileLoad, true);
    return () => document.removeEventListener("load", handleTileLoad, true);
  }, [mapStyle, apiKeyReady]);

  return null;
}