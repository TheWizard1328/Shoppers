import { useEffect, useRef } from "react";
import { base44 } from "@/api/base44Client";
import { getDeviceIdentifier } from "@/components/utils/userSettingsManager";
import { useUser } from "@/components/utils/UserContext";

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

// ─── Single-count guard (owner request Nov 27 2026) ──────────────────────────
// Several maps can be mounted at once (the dashboard map stays alive underneath
// the deviation editor dialog), and each one now mounts a tracker. Without this
// guard every tile fetch would be counted once PER tracker. The highest-priority
// surface wins, which is also the right attribution: the small foreground map is
// the one the user is actually working in.
const SURFACE_PRIORITY = {
  patient_portal: 60,
  deviation_editor: 50,
  breadcrumb_editor: 45,
  store_map_dialog: 40,
  patient_gps_map: 35,
  dashboard: 10,
};
const _mountedTrackers = new Map();
let _trackerSeq = 0;
const isTopSurface = (id) => {
  let bestId = null;
  let bestPriority = -1;
  for (const [tid, rec] of _mountedTrackers) {
    if (rec.priority > bestPriority) { bestPriority = rec.priority; bestId = tid; }
  }
  return bestId === id;
};

// SURFACE + PATIENT ATTRIBUTION (owner request Nov 27 2026):
// The tile log only said WHICH device fetched tiles, never WHICH MAP or, on the
// patient portal, WHICH PATIENT. Two extra fields fix both:
//   surface     — 'dashboard' | 'patient_portal' | 'deviation_editor' |
//                 'breadcrumb_editor' | 'patient_gps_map' | 'store_map_dialog'
//   attribution — { actorType: 'patient', actorId, actorName } so a portal tile
//                 bill lands on the patient who was watching, not on no one.
// Every map that fetches HERE tiles must mount this tracker, otherwise the
// fetchAndCache() event fires with no listener and the spend is invisible.
export default function HereTileUsageTracker({ mapStyle, apiKeyReady, currentUser, surface = 'dashboard', attribution = null }) {
  // Fall back to the shared UserContext when a caller does not pass a user, so
  // admin maps (deviation editor, breadcrumb editor) log the same identity as
  // the dashboard without every parent having to thread currentUser through.
  const { currentUser: ctxUser } = useUser() || {};
  const trackerIdRef = useRef(0);
  if (trackerIdRef.current === 0) trackerIdRef.current = ++_trackerSeq;
  const pendingCountRef = useRef(0);
  const flushTimeoutRef = useRef(null);
  // Keep a ref to the latest currentUser so the flush closure always sees
  // the most up-to-date user even if it arrives after the effect ran
  const currentUserRef = useRef(currentUser || ctxUser);
  useEffect(() => { currentUserRef.current = currentUser || ctxUser; }, [currentUser, ctxUser]);
  // Attribution can arrive after mount (patient record loads late), so read it
  // through a ref at flush time exactly like the user.
  const attributionRef = useRef(attribution);
  useEffect(() => { attributionRef.current = attribution; }, [attribution]);

  // Register this tracker so only the top surface counts a shared fetch.
  useEffect(() => {
    const id = trackerIdRef.current;
    _mountedTrackers.set(id, { priority: SURFACE_PRIORITY[surface] ?? 5 });
    return () => { _mountedTrackers.delete(id); };
  }, [surface]);

  useEffect(() => {
    if (!apiKeyReady) return;

    const flushLogs = async () => {
      const count = pendingCountRef.current;
      pendingCountRef.current = 0;
      flushTimeoutRef.current = null;
      if (!count) return;

      // Always read from ref so we get the latest user at flush time
      const user = currentUserRef.current;
      const attrib = attributionRef.current;
      const actorType = attrib?.actorType || (user ? 'app_user' : 'unknown');
      const actorId = attrib?.actorId || user?.user_id || null;
      const actorName = attrib?.actorName || user?.user_name || null;

      try {
        await base44.entities.GoogleAPILog.create({
          timestamp: getTodayTimestamp(),
          api_type: "Map Tiles (HERE)",
          purpose: `Fetched ${count} HERE map tile${count === 1 ? "" : "s"} from network`,
          function_name: "HereTileUsageTracker",
          // Identity from AppUser only — never auth Users.full_name. On the
          // patient portal the actor is the PATIENT, passed via attribution.
          user_id: actorId,
          user_name: actorName,
          metadata: {
            provider: "HERE",
            source: "network_fetch",
            map_style: mapStyle || "explore",
            surface,
            actor_type: actorType,
            patient_id: attrib?.patientId || null,
            patient_name: attrib?.patientName || null,
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
      // A lower-priority map underneath must not double-count this fetch.
      if (!isTopSurface(trackerIdRef.current)) return;
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
  }, [apiKeyReady, mapStyle, surface]); // intentionally omit currentUser — we use the ref

  return null;
}