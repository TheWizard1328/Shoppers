import { useEffect, useRef } from "react";
import { base44 } from "@/api/base44Client";
import { getDeviceIdentifier } from "@/components/utils/userSettingsManager";

// DEVICE TAG (owner request Nov 12 2026): the tile log only recorded the login,
// so a spike could be pinned to "Robert Tauber" but never to WHICH machine —
// and that account runs the editor, the desktop PWA and the phone. Every row
// now carries the stable local device id plus a coarse platform label, so a
// rise in tile spend can be attributed to one device.
const deviceLabel = () => {
  try {
    const ua = navigator.userAgent || "";
    const platform = navigator.platform || "";
    const apk = /; wv\)/.test(ua) || window.Capacitor ? "APK" : "Web";
    const os = /Android/i.test(ua) ? "Android" : /Windows/i.test(ua) ? "Windows" : /Mac/i.test(platform) ? "Mac" : /Linux/i.test(ua) ? "Linux" : "Other";
    const screen = `${window.screen?.width || 0}x${window.screen?.height || 0}`;
    return `${apk}/${os}/${screen}`;
  } catch { return "unknown"; }
};

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
          // Identity from AppUser only — never auth Users.full_name
          user_id: user?.user_id || null,
          user_name: user?.user_name || null,
          metadata: {
            provider: "HERE",
            source: "network_fetch",
            map_style: mapStyle || "explore",
            call_count: count,
            device_identifier: (() => { try { return getDeviceIdentifier(); } catch { return null; } })(),
            device_label: deviceLabel(),
            map_zoom: (() => { try { const z = Number(window.__rxTileZoom); return Number.isFinite(z) ? z : null; } catch { return null; } })(),
            page: typeof window !== "undefined" ? (window.location?.pathname || "") : ""
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