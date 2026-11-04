import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import PWAInstallPrompt from '@/components/common/PWAInstallPrompt';
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Menu, X, Package, MapPin, Clock, Truck, CheckCircle, RefreshCw, HeartPulse, Wifi, MessageSquare } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { PatientSessionManager } from '@/components/patient-portal/PatientSessionManager';
import PatientPortalGuard from '@/components/patient-portal/PatientPortalGuard';
import PatientSidebar from '@/components/patient-portal/PatientSidebar';
import PatientTodayFloatingCard from '@/components/patient-portal/PatientTodayFloatingCard';
import MapCrosshair from '@/components/dashboard/MapCrosshair';
import PatientMessaging, { loadPatientUnreadCount } from '@/components/patient-portal/PatientMessaging';
import PatientNotifyPrompt from '@/components/patient-portal/PatientNotifyPrompt';
import { resolveLinkedPatientIds } from '@/components/utils/patientLinkedRecords';
import PatientNotificationToggle from '@/components/patient-portal/PatientNotificationToggle';
import { format } from 'date-fns';
import { isPatientViewOverlayActive, requestExitPatientView } from '../components/patient-portal/patientViewExit';
import { createLiveMarkerInterpolator } from '@/components/utils/liveMarkerInterpolator';
import { getHereApiKey } from '@/components/utils/hereApiKeyStore';
import { patientPortalPing } from '@/functions/patientPortalPing';
import UpdateInfoBalloon from '@/components/common/UpdateInfoBalloon';
import { useWebUpdateCheck } from '@/components/utils/useWebUpdateCheck';
import { initInteractionIdleTracker, getIdleMs } from '@/components/utils/interactionIdleTracker';
import { clearUserCache } from '@/components/utils/auth';
import { purgeStaleServiceWorkerAndCaches } from '@/components/utils/ChunkErrorBoundary';
import { isAppDarkTheme } from '@/lib/utils';

// Fix default Leaflet icon paths
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png'
});

// OWNER REQUEST (Nov 3 2026): the driver's live location must be visible even
// while the patient's delivery is still PENDING (the driver is already working
// and has not picked this parcel up yet). Every live-tracking gate in this page
// reads this one list so pending / en route / in transit all behave alike.
const LIVE_DRIVER_STATUSES = ['pending', 'en_route', 'in_transit'];

/**
 * ONE hard-update routine for the patient portal (owner request Nov 3 2026:
 * "is pressing that refresh button supposed to do a complete app restart to
 * install the update, like the force full app refresh the staff have?").
 *
 * A plain reload is not enough: the service worker and Cache Storage can hand
 * back the OLD index.html, which still points at the old hashed chunks, so the
 * patient comes back to the same build with the update dot still showing. This
 * runs the SAME purge the staff "Clear Cache & Refresh" recovery uses (SW
 * unregister + Cache Storage wipe, HERE tile caches preserved), drops the user
 * cache, revalidates the document, then reloads onto the new build.
 */
async function applyPortalUpdate() {
  try {localStorage.setItem('rxdeliver_auto_updated_at', String(Date.now()));} catch {/* ignore */}
  try {clearUserCache();} catch {/* silent */}
  try {await purgeStaleServiceWorkerAndCaches();} catch {/* silent */}
  // Revalidate the document: a plain reload can return the cached index.html.
  try {
    await fetch(`/?_u=${Date.now()}`, { cache: 'reload', credentials: 'same-origin' });
  } catch {/* offline — the cache wipe still helps */}
  window.location.reload();
}

const HOUSE_SVG = (strokeColor) =>
`<svg xmlns='http://www.w3.org/2000/svg' width='18' height='18' viewBox='0 0 24 24' fill='none' stroke='${strokeColor}' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'><path d='M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'/><polyline points='9 22 9 12 15 12 15 22'/></svg>`;

function makeStoreIcon(pickupDone) {
  const bg = pickupDone ? '#16a34a' : 'white';
  const border = pickupDone ? '#15803d' : '#e2e8f0';
  return L.divIcon({
    html: `<div style="background:${bg};width:40px;height:40px;border-radius:10px;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(0,0,0,0.3);border:2px solid ${border};overflow:hidden;"><img src="https://media.base44.com/images/public/68570f3cd01bfa2d2408a9d6/189b7cc2c_ShoppersLogo.ico" style="width:30px;height:30px;object-fit:contain;" /></div>`,
    className: '',
    iconSize: [40, 40],
    iconAnchor: [20, 20]
  });
}

function makePatientIcon(deliveryStatus, isNextDelivery, stopsBeforeCount) {
  let bg = '#2563eb';
  let iconColor = 'white';
  if (deliveryStatus === 'completed') {bg = '#16a34a';} else
  if (deliveryStatus === 'failed') {bg = '#dc2626';} else
  if (isNextDelivery) {bg = '#ca8a04';iconColor = '#fef08a';}

  // Cluster badge: show stops-before count only when delivery is not yet done and count > 0
  const showBadge = stopsBeforeCount != null && stopsBeforeCount > 0 && !['completed', 'failed', 'cancelled'].includes(deliveryStatus);
  const badge = showBadge ?
  `<div style="position:absolute;top:-6px;right:-6px;background:#ef4444;color:white;border-radius:50%;width:20px;height:20px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;border:2px solid white;box-shadow:0 1px 4px rgba(0,0,0,0.4);z-index:10;">${stopsBeforeCount}</div>` :
  '';

  return L.divIcon({
    html: `<div style="position:relative;width:36px;height:36px;"><div style="background:${bg};color:white;width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(0,0,0,0.3);border:3px solid white;">${HOUSE_SVG(iconColor)}</div>${badge}</div>`,
    className: '',
    iconSize: [36, 36],
    iconAnchor: [18, 18]
  });
}

// Balloon-knob tail (owner request, Sep 29 2026): a small triangle at the
// bottom of the circle points the TIP at the driver's exact GPS spot on the
// road. The icon anchor is the tip (bottom-center of the tail), so the circle
// body rides visibly ABOVE the driving line instead of straddling it — making
// it obvious which point along the road the driver actually is.
// v2 (owner request, Sep 29 2026): the tail is drawn as an EXTENSION of the
// white ring border — an SVG triangle with a 3px white stroke and green fill,
// tucked 5px up behind the circle so the ring visually flows down into the
// tail (speech-balloon knob) instead of a detached green wedge.
const DRIVER_MARKER_HTML = (inner) => `<div style="position:relative;width:36px;height:46px;filter:drop-shadow(0 2px 4px rgba(0,0,0,0.3));">
  <div style="background:#16a34a;color:white;width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:18px;border:3px solid white;box-sizing:border-box;">${inner}</div>
  <svg style="position:absolute;left:0;top:31px;overflow:visible;" width="36" height="15" viewBox="0 0 36 15">
    <path d="M13 0 L18 15 L23 0 Z" fill="#16a34a" stroke="#ffffff" stroke-width="3" stroke-linejoin="round"/>
  </svg>
</div>`;

const driverIcon = L.divIcon({
  html: DRIVER_MARKER_HTML('🚚'),
  className: '',
  iconSize: [36, 46],
  iconAnchor: [18, 46]
});

// Cycling-mode driver icon: bicycle with a rider wearing a backpack.
const CYCLIST_SVG = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="#ffffff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="5.5" cy="17.5" r="3.2"/>
  <circle cx="18.5" cy="17.5" r="3.2"/>
  <path d="M5.5 17.5 L12 17.5"/>
  <path d="M12 17.5 L9 10.5"/>
  <path d="M9 10.5 L5.5 17.5"/>
  <path d="M9 10.5 L16 10"/>
  <path d="M12 17.5 L16 10 L18.5 17.5"/>
  <path d="M8 10.1 L10 10.1"/>
  <path d="M15.4 10 L16.6 9.2"/>
  <path d="M9 10 L12.4 13.4 L12 17.3"/>
  <path d="M13.8 6.6 L9 10"/>
  <path d="M13.8 6.6 L16.2 9.6"/>
  <circle cx="15" cy="5.1" r="1.6" fill="#ffffff" stroke="none"/>
  <g transform="translate(9.4,5.4) rotate(-35)">
    <rect x="-2.1" y="-3.2" width="4.2" height="6.4" rx="1.4" fill="#ffffff" stroke="none"/>
    <path d="M-1.2 1.4 H1.2" stroke="#16a34a" stroke-width="0.8" opacity="0.5"/>
  </g>
</svg>`;

const cyclingDriverIcon = L.divIcon({
  html: DRIVER_MARKER_HTML(CYCLIST_SVG),
  className: '',
  iconSize: [36, 46],
  iconAnchor: [18, 46]
});

// Smoothly animated driver marker — mirrors the shared-location glide used for
// driver dots on dispatcher devices (LiveDriverLocationInterpolator trail mode).
// The declarative position is seeded ONCE; every 15s AppUser fix is handed to
// the interpolator and the rAF loop moves the marker imperatively via
// setLatLng so Leaflet never tears down/rebuilds its DOM on each update.
function AnimatedDriverMarker({ driverLocation, legCoords, icon, children, onPaint }) {
  const markerRef = useRef(null);
  const interpRef = useRef(null);
  const initialPosRef = useRef(null);
  const rafRef = useRef(0);
  const lastPaintRef = useRef(0);
  // OWNER SPEC (Oct 23 2026): the map's auto-fit rides the MARKER's own
  // movement — the rAF glide emits the painted position (the exact motion the
  // patient sees) so the refit is linked to the dot, not to a timer/poll.
  const onPaintRef = useRef(onPaint);
  onPaintRef.current = onPaint;
  const lastPaintEmitRef = useRef(0);

  if (!interpRef.current) interpRef.current = createLiveMarkerInterpolator({ mode: 'trail' });

  // Seed the stable React position once — later movement is imperative only
  if (!initialPosRef.current && driverLocation) {
    initialPosRef.current = [Number(driverLocation.lat), Number(driverLocation.lng)];
  }

  // Feed each new 15s fix to the interpolator, along with the current-leg
  // road geometry so the glide follows the route instead of cutting corners.
  useEffect(() => {
    if (!driverLocation) return;
    const la = Number(driverLocation.lat);
    const lng = Number(driverLocation.lng);
    if (!Number.isFinite(la) || !Number.isFinite(lng)) return;
    if (!initialPosRef.current) initialPosRef.current = [la, lng];
    interpRef.current.setPath(Array.isArray(legCoords) && legCoords.length > 1 ? legCoords : null);
    interpRef.current.onFix(la, lng, Date.now());
  }, [driverLocation?.lat, driverLocation?.lng, legCoords]);

  // rAF glide loop (~20fps) — same paint cadence as the dashboard trail dots
  useEffect(() => {
    const loop = () => {
      rafRef.current = window.requestAnimationFrame(loop);
      const now = Date.now();
      if (now - lastPaintRef.current < 50) return;
      lastPaintRef.current = now;
      const marker = markerRef.current;
      if (!marker?.setLatLng) return;
      const p = interpRef.current.getDisplayPosition(now);
      if (p) {
        marker.setLatLng([p.latitude, p.longitude]);
        if (onPaintRef.current && now - lastPaintEmitRef.current >= 500) {
          lastPaintEmitRef.current = now;
          onPaintRef.current(p.latitude, p.longitude);
        }
      }
    };
    rafRef.current = window.requestAnimationFrame(loop);
    return () => window.cancelAnimationFrame(rafRef.current);
  }, []);

  if (!driverLocation) return null;
  return (
    <Marker ref={markerRef} position={initialPosRef.current} icon={icon}>
      {children}
    </Marker>);

}

// Fits the map to patient + store on load (once both are available).
// If the driver is live, fits driver + patient instead.
// Shared portal fit (owner spec Oct 23 2026): 50px padding on all four sides,
// zoom FLOORED at 13 so the view never zooms out past street level (long routes
// crop their far legs instead of shrinking everything) and capped at 17.
// Leaflet's fitBounds IGNORES its minZoom option (and zoomSnap is a no-op
// there), so the zoom is computed manually and applied with flyTo.
const PORTAL_FIT_MAX_ZOOM = 17;
// INNER map padding (owner spec Nov 2 2026). These are the paddings the auto
// fit keeps the driver and patient markers away from, NOT container padding —
// the map itself stays full height and the today card floats over it.
//   sides  : 50px, unchanged
//   bottom : 75px — the old TOP padding, because the tracking badge moved from
//            the top of the map to the bottom
//   top    : the collapsed height of the floating today card, so the two
//            markers never tuck underneath it
// OWNER TWEAK (Nov 2 2026): sides cut from 50 to 20 so the driver and patient
// sit closer to the map edges.
const PORTAL_PAD_SIDE = 20;
// OWNER TWEAK (Nov 2 2026): bottom padding reduced by 40 (75 -> 35) and the top
// padding raised by the same 40 so the frame sits lower on the map.
const PORTAL_PAD_BOTTOM = 35;
// Sidebar visible (desktop, or the drawer open): the top padding matches the
// bottom exactly — no card to clear. OWNER TWEAK Nov 2 2026.
const PORTAL_PAD_TOP_DEFAULT = 35;
function portalFit(map, points, pad = {}) {
  // Guard: a single NaN/undefined coordinate makes latLngBounds invalid and
  // getBoundsZoom throw — which would silently kill the auto-fit forever.
  const pts = (points || []).
  filter((pt) => Array.isArray(pt) && Number.isFinite(Number(pt[0])) && Number.isFinite(Number(pt[1]))).
  map(([a, b]) => [Number(a), Number(b)]);
  if (pts.length === 0) return;
  const bounds = L.latLngBounds(pts);
  const topPad = Number.isFinite(pad.top) ? pad.top : PORTAL_PAD_TOP_DEFAULT;
  const bottomPad = Number.isFinite(pad.bottom) ? pad.bottom : PORTAL_PAD_BOTTOM;
  const leftPad = Number.isFinite(pad.left) ? pad.left : PORTAL_PAD_SIDE;
  const rightPad = Number.isFinite(pad.right) ? pad.right : PORTAL_PAD_SIDE;
  // NOTE: L.Point.add() MUTATES the point it is called on, so the fit padding
  // uses its own throwaway point — otherwise paddingOffset below would be
  // computed from already-doubled values (a long-standing bug in this fit).
  const fitZoom = map.getBoundsZoom(bounds, false, L.point(leftPad + rightPad, topPad + bottomPad));
  // OWNER FIX (Oct 23 2026): the 13-floor was over-zooming — on long
  // driver↔patient spans the true fit is ~10-12, and forcing 13 zoomed IN
  // past the fit, pushing both markers off screen. Now the auto-fit uses
  // the exact computed zoom (only capped at 17 so a degenerate tiny box
  // can't pinch all the way in). Leaflet's fitBounds always ignored the
  // minZoom option anyway, so this matches the pre-Oct-23 behavior.
  const targetZoom = Number.isFinite(fitZoom) ?
  Math.min(PORTAL_FIT_MAX_ZOOM, fitZoom) :
  PORTAL_FIT_MAX_ZOOM;
  // Asymmetric padding shifts the center the same way Leaflet's
  // _getBoundsCenterZoom does: paddingOffset = (bottomRight - topLeft) / 2.
  const paddingOffset = L.point(rightPad - leftPad, bottomPad - topPad).divideBy(2);
  const swPoint = map.project(bounds.getSouthWest(), targetZoom);
  const nePoint = map.project(bounds.getNorthEast(), targetZoom);
  const center = map.unproject(swPoint.add(nePoint).divideBy(2).add(paddingOffset), targetZoom);
  map.flyTo(center, targetZoom, { duration: 0.75 });
}

function MapBoundsFitter({ patientLatLng, storeLatLng, driverLatLng, showDriver, routeCoords, mapPad, settledOnly = false }) {
  const map = useMap();
  // ONE SIGNATURE PER FIT (owner report Nov 3 2026): the fit used to key off a
  // point COUNT plus the pad, so a coordinate that arrived in a later wave was
  // never framed — the map sat on the patient alone for a finished delivery until
  // the side panel changed the padding, and with no delivery today it parked on
  // the store without ever zooming out to both. Every input that can widen the
  // frame is now folded into one signature; any change refits exactly once.
  const signature = [
  patientLatLng ? patientLatLng.join(',') : '',
  storeLatLng ? storeLatLng.join(',') : '',
  showDriver && driverLatLng ? driverLatLng.join(',') : '',
  String(mapPad?.top ?? ''),
  String(mapPad?.bottom ?? ''),
  settledOnly ? 'settled' : 'live',
  Array.isArray(routeCoords) ? routeCoords.length : 0].
  join('|');
  const fittedSignatureRef = useRef(null);

  // ── SETTLE WINDOW (owner report Nov 3 2026) ──────────────────────────────
  // The map made three jumps in a row on load: the container's own initial
  // centre, then our fit for the patient, then another when the store location
  // arrived (and sometimes a third when the "notifications blocked" banner
  // changed the map height). Nothing auto-fits for the first 2 seconds, so the
  // first thing the patient sees is one clean pan/zoom for every point we have.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setArmed(true), 2000);
    return () => clearTimeout(t);
  }, []);

  // Last frame we drew, so a container resize can redraw the SAME frame instead
  // of leaving markers outside the visible map.
  const lastFrameRef = useRef({ points: null, pad: null });
  const doFit = useCallback((points, pad) => {
    lastFrameRef.current = { points, pad };
    portalFit(map, points, pad);
  }, [map]);

  // ── RESIZE REFIT (owner report Nov 3 2026) ────────────────────────────────
  // A banner appearing/disappearing (notifications blocked, update available,
  // safe-area changes on rotate) shrinks the map, which used to push bottom
  // markers off screen and never brought them back.
  useEffect(() => {
    const container = map?.getContainer?.();
    if (!container || typeof ResizeObserver === 'undefined') return undefined;
    let timer = null;
    const observer = new ResizeObserver(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const { points, pad } = lastFrameRef.current || {};
        if (Array.isArray(points) && points.length > 0) portalFit(map, points, pad);
      }, 220);
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [map]);

  useEffect(() => {
    // Must have the patient's location for any meaningful frame.
    if (!patientLatLng) return;
    // Nothing fits until the 2-second settle window closes (unless the map is
    // already showing a frame and only needs a redraw).
    if (!armed && !fittedSignatureRef.current) return;
    if (fittedSignatureRef.current === signature) return;
    fittedSignatureRef.current = signature;

    // ── SETTLED FOCUS (owner rule Nov 3 2026) ────────────────────────────────
    // Completed or failed delivery: pan/zoom to the patient's home and the pickup
    // location ONLY. The driver has already been here, so his position and the
    // remaining route must not stretch the frame.
    if (settledOnly) {
      const points = storeLatLng ? [patientLatLng, storeLatLng] : [patientLatLng];
      doFit(points, mapPad);
      return;
    }

    const routePoints = Array.isArray(routeCoords) ? routeCoords : [];
    if (showDriver && driverLatLng) {
      doFit([driverLatLng, patientLatLng, ...routePoints], mapPad);
    } else if (storeLatLng) {
      // Normal case: fit store + patient (+ any visible route geometry)
      doFit([storeLatLng, patientLatLng, ...routePoints], mapPad);
    }
  }, [signature, armed, doFit, patientLatLng, storeLatLng, driverLatLng, showDriver, routeCoords, mapPad?.top, mapPad?.bottom, settledOnly]);
  return null;
}

// Tracks driver+patient — ALWAYS-ON "map cycle FAB Phase 2" behavior (owner
// spec Oct 23 2026): the map continuously pans AND zooms so the driver and the
// patient are both kept in view. A user zoom/drag pauses the auto-fit for
// PAUSE_MS, then it reactivates on its own. A programmatic flag keeps the
// auto-fit from pausing itself (fitBounds fires the same zoomstart/drag-adjacent
// events a user gesture does — without the flag the tracker would disable
// itself on every driver tick, which is exactly why tracking never stuck).
function DriverTracker({ driverLocation, driverPaintPos, patientLatLng, trackingMode, onDoubleTap, onUserInteract, routeCoords, mapPad }) {
  const map = useMap();
  const programmaticRef = useRef(false);

  // Auto-fit (Phase 2): whenever the driver moves (or tracking resumes after a
  // pause), pan AND zoom to frame driver + patient — PLUS the full visible
  // route path so every intermediate stop between the driver and the patient
  // stays in view (owner spec Oct 23 2026; stops aren't shown as markers, but
  // their legs define the bounds).
  // OWNER SPEC (Oct 23 2026): auto pan/zoom is LINKED TO THE MARKER's
  // movement — every painted position the rAF glide emits (≥40m since the
  // last fit, gated in the page) re-fits the frame. No timers, no polling.
  // The 10s manual-interaction pause (trackingMode) still applies.
  const anchor = driverPaintPos || (driverLocation ? [Number(driverLocation.lat), Number(driverLocation.lng)] : null);
  useEffect(() => {
    if (!trackingMode || !anchor || !patientLatLng) return;
    const positions = [
    anchor,
    patientLatLng];

    const routePoints = Array.isArray(routeCoords) ? routeCoords : [];
    if (routePoints.length > 1) positions.push(...routePoints);
    programmaticRef.current = true;
    // Zoom clamps (owner feedback Oct 23 2026): minZoom is the floor that
    // keeps the fit from zooming OUT too far on long routes (their outer legs
    // crop off-screen instead of shrinking everything); maxZoom stops a
    // degenerate tight fit from pinching all the way in. Small buffer — the
    // markers should sit close to the map edges, not centered with big gaps.
    portalFit(map, positions, mapPad);
    const clearProgrammatic = () => {programmaticRef.current = false;};
    map.once('moveend', clearProgrammatic);
    map.once('zoomend', clearProgrammatic);
    // Bounds unchanged (no move/zoom events fire) — clear via short safety
    // timer (flyTo animation is 0.75s, so clear comfortably after it).
    const safetyTimer = setTimeout(clearProgrammatic, 1500);
    return () => {
      clearTimeout(safetyTimer);
      map.off('moveend', clearProgrammatic);
      map.off('zoomend', clearProgrammatic);
      programmaticRef.current = false;
    };
    // routeCoords identity changes only when the visible legs change (new stop
    // accepted, completion, regen) — refit then so the frame tracks the route.
  }, [anchor?.[0], anchor?.[1], trackingMode, routeCoords, mapPad?.top, mapPad?.bottom]);

  // Double-tap resumes tracking immediately; USER zoom/drag starts the 10s
  // pause. Programmatic fits are flagged and ignored.
  useEffect(() => {
    const handleDblClick = () => onDoubleTap();
    map.on('dblclick', handleDblClick);
    const handleUserGesture = () => {if (!programmaticRef.current) onUserInteract();};
    map.on('dragstart', handleUserGesture);
    map.on('zoomstart', handleUserGesture);
    return () => {
      map.off('dblclick', handleDblClick);
      map.off('dragstart', handleUserGesture);
      map.off('zoomstart', handleUserGesture);
    };
  }, [map, onDoubleTap, onUserInteract]);

  return null;
}

const TODAY = format(new Date(), 'yyyy-MM-dd');

// Decode Google-encoded polyline to [[lat, lng], ...]
function decodePolyline(encoded) {
  if (!encoded || typeof encoded !== 'string') return [];
  let index = 0,lat = 0,lng = 0;
  const coords = [];
  while (index < encoded.length) {
    let b,shift = 0,result = 0;
    do {b = encoded.charCodeAt(index++) - 63;result |= (b & 0x1f) << shift;shift += 5;} while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    shift = 0;result = 0;
    do {b = encoded.charCodeAt(index++) - 63;result |= (b & 0x1f) << shift;shift += 5;} while (b >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;
    coords.push([lat / 1e5, lng / 1e5]);
  }
  return coords;
}

export default function PatientPortal({ embedded = false } = {}) {
  const patient = PatientSessionManager.getPatient();

  // ── Presence heartbeat (owner spec Oct 23 2026) ──────────────────────────
  // While this portal tab is VISIBLE, ping presence every 30s so dashboards
  // can show drivers/dispatchers that this patient is watching the route.
  // Pauses when the tab is hidden (no phantom watchers), immediate ping on
  // return. The server only records a row when the patient has a delivery
  // for the date (owner gate rule).
  useEffect(() => {
    if (!patient?.id) return;
    let ping = () => {
      if (document.visibilityState !== 'visible') return;
      const dateStr = format(new Date(), 'yyyy-MM-dd');
      patientPortalPing({ patient_id: patient.id, delivery_date: dateStr }).catch(() => {});
    };
    ping();
    const timer = setInterval(ping, 30000);
    const onVisibility = () => {if (document.visibilityState === 'visible') ping();};
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [patient?.id]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Patient messaging (owner build Nov 2 2026): one thread with the pharmacy,
  // unread badge on the header button, pushed to the device when a reply lands.
  const [messagingOpen, setMessagingOpen] = useState(false);
  // App-owner only: on narrow screens the Exit control lives here in the header's
  // free space (owner request Nov 3 2026) instead of inside the floating card.
  const [canExitPreview] = useState(isPatientViewOverlayActive);
  const [unreadMessages, setUnreadMessages] = useState(0);
  const [deliveries, setDeliveries] = useState([]);
  const [pickupStops, setPickupStops] = useState([]);
  // Every record sharing each puid (pickup + its deliveries) — lets a transferred
  // delivery find the pickup that actually collected the parcel, even when that
  // was another driver on an earlier date (owner request Nov 3 2026).
  const [puidGroups, setPuidGroups] = useState({});
  const [stores, setStores] = useState([]);
  const [todayDelivery, setTodayDelivery] = useState(null);
  // Live calendar day for the floating today-card gate. TODAY is a module
  // constant (frozen at load), so a portal left open past midnight would keep
  // offering yesterday's card — the floating card compares against this one and
  // its own minute tick instead.
  const [liveDay, setLiveDay] = useState(() => format(new Date(), 'yyyy-MM-dd'));
  // Height of the collapsed floating today card. The map area reserves this as
  // TOP PADDING so the card never covers the map (owner request Nov 2 2026).
  const [floatCardHeight, setFloatCardHeight] = useState(0);
  // The floating today card only exists when the sidebar is HIDDEN and the
  // screen is narrow (on md+ the sidebar is permanently visible). Track that
  // breakpoint in JS so the top fit padding can drop the card height whenever
  // the sidebar is on screen (owner request Nov 2 2026).
  const [isNarrowScreen, setIsNarrowScreen] = useState(() =>
  typeof window !== 'undefined' && window.matchMedia ?
  window.matchMedia('(max-width: 767px)').matches :
  false
  );
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const mq = window.matchMedia('(max-width: 767px)');
    const onChange = (e) => setIsNarrowScreen(e.matches);
    mq.addEventListener ? mq.addEventListener('change', onChange) : mq.addListener(onChange);
    return () => {
      mq.removeEventListener ? mq.removeEventListener('change', onChange) : mq.removeListener(onChange);
    };
  }, []);

  const showFloatTodayCard = !!(
  todayDelivery &&
  todayDelivery.delivery_date === liveDay &&
  !sidebarOpen &&
  isNarrowScreen);


  // Inner fit paddings handed to every auto-fit call: top clears the floating
  // today card WHEN IT IS SHOWING (otherwise just the base 115), bottom clears
  // the tracking badge that now lives down there.
  const mapPad = useMemo(() => ({
    left: 20,
    right: 20,
    bottom: 35,
    // Card showing (sidebar hidden on a narrow screen): card height + 32
    // (was + 52, cut by 20 per owner tweak Nov 2 2026). Sidebar visible: 35,
    // identical to the bottom padding.
    top: showFloatTodayCard && floatCardHeight ? floatCardHeight + 32 : PORTAL_PAD_TOP_DEFAULT
  }), [showFloatTodayCard, floatCardHeight]);
  const [driverLocation, setDriverLocation] = useState(null);

  // ── Dark mode map tiles (owner Oct 23 2026): follow the app's theme ────────
  // Same detection the dashboard map uses: the 'dark-theme' root class, or
  // 'auto-theme' + system prefers-dark. A MutationObserver flips tiles live
  // when the theme changes.
  const [isDarkTheme, setIsDarkTheme] = useState(() => isAppDarkTheme());
  const [hereApiKey, setHereApiKey] = useState(() => getHereApiKey() || null);
  useEffect(() => {
    const observer = new MutationObserver(() => {
      const dark = isAppDarkTheme();
      setIsDarkTheme((prev) => prev === dark ? prev : dark);
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const { getOrFetchHereApiKey } = await import('@/components/utils/hereApiKeyStore');
        const key = await getOrFetchHereApiKey();
        if (mounted && key) setHereApiKey((prev) => prev === key ? prev : key);
      } catch {/* OSM/Carto fallback stays active */}
    })();
    return () => {mounted = false;};
  }, []);
  const tileUrl = useMemo(() => {
    if (hereApiKey) {
      // Same HERE v3 tiles the dashboard uses (512px, zoomOffset -1 at render).
      return isDarkTheme ?
      `https://maps.hereapi.com/v3/base/mc/{z}/{x}/{y}/png?style=explore.night&size=512&apiKey=${hereApiKey}` :
      `https://maps.hereapi.com/v3/base/mc/{z}/{x}/{y}/png?style=explore.day&size=512&apiKey=${hereApiKey}`;
    }
    // CARTO basemaps now watermark "API KEY REQUIRED" (policy change Oct 2026,
    // seen live on a patient's phone Oct 26) — replaced with plain OSM for BOTH
    // themes. Dark mode is handled by the .portal-osm-dark CSS filter (below),
    // so no key and no third-party account is needed.
    return 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
  }, [hereApiKey, isDarkTheme]);
  // OWNER FIX (Oct 23 2026): the regular route line colors (green-600 /
  // mode) sink into the dark night tiles, so the line brightens for dark mode.
  // OWNER SPEC Nov 2 2026: the whole path is always GREEN — the blue current-leg
  // colour is gone; the active leg is still drawn heavier so it reads as current.
  const routeLegColor = isDarkTheme ? '#4ade80' : '#16a34a';
  const currentLegColor = routeLegColor;
  const [loading, setLoading] = useState(true);
  // Spinner while the refresh button runs a data refresh or installs an update.
  const [updating, setUpdating] = useState(false);
  const [liveConnected, setLiveConnected] = useState(false);
  // Stops REMAINING today on the driver's route — ONE number for both surfaces
  // (the red badge on the patient's home marker AND the card's "stops left"
  // line), owner fix Nov 3 2026. Previously the badge counted non-terminal
  // stops AHEAD of the patient (pickups included) while the card counted only
  // live PATIENT deliveries, so Phoenix Campbell read 8 on the map and 6 on the
  // card. Both now use countStopsRemaining below.
  const [stopsRemaining, setStopsRemaining] = useState(null);
  const [routeDeliveries, setRouteDeliveries] = useState([]);
  // trackingMode: Phase 2 auto-fit (driver+patient always in view) — ON by
  // default and self-reactivating: a user zoom/drag pauses it for 10s, then it
  // resumes automatically (owner spec Oct 23 2026).
  const [trackingMode, setTrackingMode] = useState(true);
  const trackingResumeTimerRef = useRef(null);

  // Latest PAINTED position of the animated driver dot (emitted ~2x/sec by
  // the marker's rAF glide). Gated to ≥40m of movement so the page only
  // re-renders — and the auto-fit only fires — when the dot has actually
  // moved far enough to justify a reframe.
  const [driverPaintPos, setDriverPaintPos] = useState(null);
  const driverPaintPosRef = useRef(null);
  const handleDriverPaint = useCallback((lat, lng) => {
    const prev = driverPaintPosRef.current;
    if (prev) {
      const rad = Math.PI / 180;
      const dLat = (lat - prev[0]) * rad;
      const dLng = (lng - prev[1]) * rad;
      const x = dLng * Math.cos((prev[0] + lat) / 2 * rad);
      const moved = Math.sqrt(dLat * dLat + x * x) * 6371000;
      if (moved < 40) return;
    }
    driverPaintPosRef.current = [lat, lng];
    setDriverPaintPos([lat, lng]);
  }, []);
  const [driverStatus, setDriverStatus] = useState(null);

  // ── KEEP THE SCREEN ON (owner request Nov 3 2026) ─────────────────────────
  // Same behaviour the driver and dispatcher apps have: on a mobile device the
  // portal holds a screen Wake Lock so it does not dim/lock while the patient
  // is watching their driver. Re-requested every time the page becomes visible
  // (the browser drops the lock on hide), and skipped on low battery unless
  // the device is charging — a patient's phone should not be drained flat.
  useEffect(() => {
    const isMobileDevice = navigator?.maxTouchPoints > 0 || window.innerWidth <= 1024;
    if (!isMobileDevice || !('wakeLock' in navigator)) return undefined;

    let wakeLock = null;
    let battery = null;
    let cancelled = false;

    const request = async () => {
      if (cancelled || wakeLock) return;
      if (document.visibilityState !== 'visible') return;
      try {
        if (battery && battery.level * 100 < 15 && !battery.charging) return;
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => {wakeLock = null;});
      } catch {/* unsupported, denied, or battery saver — nothing to do */}
    };

    const release = () => {
      try {wakeLock?.release?.();} catch {/* already gone */}
      wakeLock = null;
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') void request();else
      release();
    };

    const watchBattery = async () => {
      if (!('getBattery' in navigator)) return;
      try {
        battery = await navigator.getBattery();
        const check = () => {
          if (battery.level * 100 < 15 && !battery.charging) release();else
          if (document.visibilityState === 'visible') void request();
        };
        battery.addEventListener?.('levelchange', check);
        battery.addEventListener?.('chargingchange', check);
      } catch {/* battery API optional */}
    };

    void watchBattery();
    void request();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      release();
    };
  }, []);

  // ── Web code update detection (owner request Nov 3 2026): patients get the
  // SAME update balloon the dispatchers, drivers and admins get, and the same
  // automatic refresh when the portal sits idle or backgrounded with a new
  // build waiting. Patients are not app users, so the balloon is driven by the
  // /version.json poll rather than an app-update broadcast Message.
  const { hasUpdate: hasWebUpdate } = useWebUpdateCheck();
  useEffect(() => {
    // Idle measurement lives in the shared tracker (Layout owns the same one;
    // the init is idempotent) so "idle" means the same thing everywhere.
    try {initInteractionIdleTracker();} catch {/* non-critical */}
  }, []);
  useEffect(() => {
    if (!hasWebUpdate) return;
    const BACKGROUND_THRESHOLD_MS = 10 * 60 * 1000; // away this long = refresh on return
    const IDLE_THRESHOLD_MS = 10 * 60 * 1000; // foreground but untouched this long
    const IDLE_RESTART_DELAY_MS = 60 * 1000; // let the balloon be seen first
    const SHORT_BACKGROUND_THRESHOLD_MS = 45 * 1000; // normal short gap resume

    const applyUpdate = applyPortalUpdate;

    let backgroundedAt = document.hidden ? Date.now() : null;
    let idleRestartTimer = null;
    const armIdleRestart = () => {
      if (idleRestartTimer) return;
      idleRestartTimer = setTimeout(() => {
        if (document.hidden) return;
        void applyUpdate();
      }, IDLE_RESTART_DELAY_MS);
    };
    const disarmIdleRestart = () => {
      if (idleRestartTimer) {clearTimeout(idleRestartTimer);idleRestartTimer = null;}
    };

    if (!document.hidden && getIdleMs() >= IDLE_THRESHOLD_MS) armIdleRestart();

    const tick = () => {
      if (document.hidden) {
        disarmIdleRestart();
        if (backgroundedAt == null) backgroundedAt = Date.now();
        if (Date.now() - backgroundedAt >= BACKGROUND_THRESHOLD_MS) void applyUpdate();
      } else {
        backgroundedAt = null;
        if (getIdleMs() >= IDLE_THRESHOLD_MS) armIdleRestart();
      }
    };
    const iv = setInterval(tick, 60 * 1000);
    const hiddenSince = { t: document.hidden ? Date.now() : null };
    const onVis = () => {
      if (document.hidden) {
        hiddenSince.t = Date.now();
        backgroundedAt = hiddenSince.t;
        disarmIdleRestart();
        return;
      }
      const awayMs = hiddenSince.t ? Date.now() - hiddenSince.t : 0;
      hiddenSince.t = null;
      backgroundedAt = null;
      if (awayMs >= SHORT_BACKGROUND_THRESHOLD_MS) {void applyUpdate();return;}
      if (getIdleMs() >= IDLE_THRESHOLD_MS) armIdleRestart();
    };
    const onActivity = () => disarmIdleRestart();
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pointerdown', onActivity, { capture: true, passive: true });
    window.addEventListener('keydown', onActivity, { capture: true, passive: true });
    window.addEventListener('touchstart', onActivity, { capture: true, passive: true });
    return () => {
      clearInterval(iv);
      disarmIdleRestart();
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pointerdown', onActivity, { capture: true });
      window.removeEventListener('keydown', onActivity, { capture: true });
      window.removeEventListener('touchstart', onActivity, { capture: true });
    };
  }, [hasWebUpdate]);

  // Keep a ref to the current todayDelivery so subscriptions can read it without
  // going stale in closures.
  const todayDeliveryRef = useRef(null);
  todayDeliveryRef.current = todayDelivery;

  // Holds the full driver route snapshot for live badge recalculation
  const routeDeliveriesRef = useRef([]);

  // ── Initial data load ─────────────────────────────────────────────
  const loadData = useCallback(async () => {
    if (!patient?.id) return;
    setLoading(true);
    try {
      // OWNER REQUEST Nov 4 2026: one login shows EVERY record that shares this
      // patient's name + phone (same person filed under more than one store),
      // so the portal merges the deliveries of all linked records instead of
      // making the patient choose which record they are at login.
      const linkedIds = await resolveLinkedPatientIds(patient);
      const idList = linkedIds.length > 0 ? linkedIds : [patient.id];
      let allDeliveries;
      if (idList.length === 1) {
        allDeliveries = await base44.entities.Delivery.filter(
          { patient_id: idList[0] },
          '-delivery_date',
          200
        );
      } else {
        const perRecord = await Promise.all(
          idList.map((pid) =>
            base44.entities.Delivery.filter({ patient_id: pid }, '-delivery_date', 200).catch(() => [])
          )
        );
        const seen = new Set();
        allDeliveries = [];
        for (const rec of perRecord.flat()) {
          if (!rec?.id || seen.has(rec.id)) continue;
          seen.add(rec.id);
          allDeliveries.push(rec);
        }
        allDeliveries.sort((a, b) => String(b.delivery_date || '').localeCompare(String(a.delivery_date || '')));
      }
      setDeliveries(allDeliveries);

      // ── PICKUP STOPS, MATCHED BY PUID ACROSS DATES (owner request Nov 3 2026) ─
      // The old lookup queried puid + delivery_date, which MISSES a transferred
      // stop: a move re-points the delivery at the target route's pickup, and the
      // parcel was physically collected by a possibly different driver on an
      // earlier date whose record carries the same puid under a different date.
      // One query per puid (no date) returns the pickup(s) AND the group's
      // deliveries on every date, which also gives real pickup/delivery times.
      const uniquePuids = [...new Set(allDeliveries.map((d) => d.puid).filter(Boolean))].slice(0, 40);
      if (uniquePuids.length > 0) {
        try {
          const results = await Promise.all(
            uniquePuids.map((puid) =>
            base44.entities.Delivery.filter({ puid }, '-delivery_date', 50).
            catch(() => [])
            )
          );
          const groups = {};
          const pickups = [];
          results.flat().forEach((rec) => {
            if (!rec?.puid) return;
            (groups[rec.puid] = groups[rec.puid] || []).push(rec);
            // A pickup stop is the record with no patient and no interstore source
            if (!rec.patient_id && !rec._interstore_source_id) pickups.push(rec);
          });
          setPuidGroups(groups);
          setPickupStops(pickups);
        } catch (_) {}
      }

      const activeToday = allDeliveries.find(
        (d) => d.delivery_date === TODAY && !['cancelled', 'failed'].includes(d.status)
      ) || null;
      setTodayDelivery(activeToday);

      if (activeToday?.status === 'completed') {
        PatientSessionManager.startExpirationTimer();
      }

      // Count stops before patient on the driver's route (and seed the live ref)
      if (activeToday?.driver_id && activeToday?.stop_order != null) {
        try {
          const routeDeliveries = await base44.entities.Delivery.filter({
            driver_id: activeToday.driver_id,
            delivery_date: TODAY
          });
          routeDeliveriesRef.current = routeDeliveries;
          setRouteDeliveries(routeDeliveries);
          setStopsRemaining(countStopsRemaining(routeDeliveries, activeToday));
        } catch (_) {
          setStopsRemaining(null);
        }
      } else {
        routeDeliveriesRef.current = [];
        setStopsRemaining(null);
      }

      // Seed driver location from initial load (no poll — WS takes over after this)
      if (activeToday?.driver_id && LIVE_DRIVER_STATUSES.includes(activeToday.status)) {
        try {
          const appUsers = await base44.entities.AppUser.filter({ user_id: activeToday.driver_id });
          const driver = appUsers?.[0];
          if (driver?.driver_status) setDriverStatus(driver.driver_status);
          if (driver?.current_latitude && driver?.current_longitude) {
            setDriverLocation({ lat: driver.current_latitude, lng: driver.current_longitude, name: driver.user_name, cycling: driver.preferred_travel_mode === 'cycling' });
          }
        } catch (_) {}
      }

      const storeIds = [...new Set([
      ...allDeliveries.map((d) => d.store_id).filter(Boolean),
      patient?.store_id,
      activeToday?.store_id].
      filter(Boolean))];
      const allStores = await base44.entities.Store.filter({});
      // Keep all stores that match any delivery store OR the patient's home store
      setStores(allStores.filter((s) => storeIds.includes(s.id)));
    } catch (err) {
      console.error('PatientPortal load error:', err);
    } finally {
      setLoading(false);
    }
  }, [patient?.id]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Keep a ref to the current todayDelivery's driver_id and stop_order for use in WS closures
  const todayDeliveryRouteRef = useRef(null);
  todayDeliveryRouteRef.current = todayDelivery ?
  { driver_id: todayDelivery.driver_id, stop_order: todayDelivery.stop_order, id: todayDelivery.id } :
  null;

  // HH:MM → minutes-past-midnight (regex only — naive strings are never Date-parsed)
  const hhmmToMinutes = (t) => {
    const m = String(t || '').trim().match(/^(\d{1,2}):(\d{2})/);
    return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
  };

  // OWNER REQUEST (Sep 29 2026): count PENDING stops in the "stops before you"
  // badge. Pending stops get a temporary optimized route order (the engine
  // sequences them with the active route and assigns cumulative ETAs), but
  // delivery edits renumber pending stops to the END of the incomplete block
  // (handleSaveDelivery: "pending last"), so stop_order alone undercounts them.
  // Rule: a non-terminal stop counts when its stop_order precedes the patient's;
  // a PENDING stop ALSO counts when its engine-assigned ETA precedes the
  // patient's ETA — the ETAs are cumulative along the optimized sequence, so
  // an earlier ETA = a temporary route position before the patient.
  // OWNER RULE (Nov 3 2026): this number is "total stops PRIOR to the
  // patient's stop" — the patient's own stop is NEVER counted. Every other
  // non-terminal stop on the driver's route today counts, store pickups
  // included (Phoenix Campbell: 5 in transit + 3 en-route pickups = 8, her own
  // pending stop excluded, and the card shows the same 8 as the map badge).
  const countStopsRemaining = useCallback((routeDeliveries, patientDelivery) => {
    const TERMINAL = ['completed', 'failed', 'cancelled'];
    return (routeDeliveries || []).filter(
      (d) => d && d.id !== patientDelivery?.id && !TERMINAL.includes(d.status)
    ).length;
  }, []);

  // Helper: recount stops before patient from a given route deliveries array
  const recountStopsRemaining = useCallback((routeDeliveries, patientDelivery) => {
    if (!patientDelivery) return;
    setStopsRemaining(countStopsRemaining(routeDeliveries, patientDelivery));
  }, [countStopsRemaining]);

  // ── WebSocket: Delivery subscription ─────────────────────────────
  // Listens for any Delivery change. Filters to this patient's records for
  // todayDelivery/deliveries state, AND tracks all route stops for the badge count.
  useEffect(() => {
    if (!patient?.id) return;

    let unsub;
    try {
      unsub = base44.entities.Delivery.subscribe((event) => {
        const updated = event?.data;
        if (!updated?.id) return;

        setLiveConnected(true);

        // --- Update route deliveries ref for badge recalculation ---
        const route = todayDeliveryRouteRef.current;
        if (route) {
          const existing = routeDeliveriesRef.current;
          const idx = existing.findIndex((d) => d.id === updated.id);
          // ROUTE MEMBERSHIP, BOTH WAYS (owner report Nov 3 2026): the snapshot
          // only ADDED or PATCHED stops that still match this driver+date, so a
          // stop TRANSFERRED to another driver never left it — its stored
          // polyline kept painting on the patient's map for the rest of the day.
          // A delivery that no longer belongs to this route is now REMOVED.
          const belongsNow = updated.driver_id === route.driver_id && updated.delivery_date === TODAY;
          if (belongsNow || idx >= 0) {
            const next = !belongsNow ?
            existing.filter((d) => d.id !== updated.id) :
            idx >= 0 ?
            existing.map((d) => d.id === updated.id ? { ...d, ...updated } : d) :
            [...existing, updated];
            routeDeliveriesRef.current = next;
            setRouteDeliveries([...next]);
            // Recount badge using the patient's own delivery as reference
            recountStopsRemaining(routeDeliveriesRef.current, route);
          }
        }

        // --- Update this patient's own deliveries ---
        if (updated.patient_id !== patient.id) return;

        // Patch deliveries list
        setDeliveries((prev) => {
          const exists = prev.some((d) => d.id === updated.id);
          if (exists) return prev.map((d) => d.id === updated.id ? { ...d, ...updated } : d);
          return [updated, ...prev];
        });

        // Keep todayDelivery in sync
        setTodayDelivery((prev) => {
          if (prev?.id === updated.id) {
            const next = { ...prev, ...updated };
            if (updated.status === 'completed') PatientSessionManager.startExpirationTimer();
            return next;
          }
          // Promote a newly-scheduled today delivery
          if (updated.delivery_date === TODAY && !['cancelled', 'failed'].includes(updated.status) && !prev) {
            return updated;
          }
          return prev;
        });
      });
    } catch (err) {
      console.warn('PatientPortal: Delivery WS subscription failed', err);
    }

    return () => {try {unsub?.();} catch (_) {}};
  }, [patient?.id, recountStopsRemaining]);

  // ── WebSocket: AppUser subscription (driver location) ────────────
  // Listens for any AppUser change. When the record matches the driver assigned
  // to today's active delivery, updates the map marker immediately — no polling.
  useEffect(() => {
    if (!patient?.id) return;

    let unsub;
    try {
      unsub = base44.entities.AppUser.subscribe((event) => {
        const updated = event?.data;
        if (!updated?.id) return;

        setLiveConnected(true);

        const today = todayDeliveryRef.current;
        const isActive = today && LIVE_DRIVER_STATUSES.includes(today.status);
        if (!isActive) return;

        // Match by user_id (the AppUser.user_id field holds the auth user id,
        // which matches delivery.driver_id)
        if (updated.user_id !== today.driver_id) return;

        if (updated.driver_status) setDriverStatus(updated.driver_status);

        if (updated.current_latitude && updated.current_longitude) {
          setDriverLocation((prev) => ({
            lat: updated.current_latitude,
            lng: updated.current_longitude,
            name: updated.user_name,
            cycling: updated.preferred_travel_mode != null ?
            updated.preferred_travel_mode === 'cycling' :
            prev?.cycling ?? false
          }));
        }
      });
    } catch (err) {
      console.warn('PatientPortal: AppUser WS subscription failed', err);
    }

    return () => {try {unsub?.();} catch (_) {}};
  }, [patient?.id]);



  // ── Clear driver location + tracking when delivery is no longer active ───────
  useEffect(() => {
    const isActive = todayDelivery && LIVE_DRIVER_STATUSES.includes(todayDelivery.status);
    if (!isActive) {
      setDriverLocation(null);
      setTrackingMode(false);
    } else {
      // Auto-enable tracking when driver becomes active
      setTrackingMode(true);
    }
  }, [todayDelivery?.status]);

  // ── Map markers ───────────────────────────────────────────────────
  const storeMap = {};
  stores.forEach((s) => {storeMap[s.id] = s;});

  const activeStore = todayDelivery ? storeMap[todayDelivery.store_id] : patient?.store_id ? storeMap[patient.store_id] : null;

  // Store marker: green bg when pickup is done (driver has left the store = in_transit/en_route/completed)
  const pickupDone = todayDelivery ? ['in_transit', 'en_route', 'completed'].includes(todayDelivery.status) : false;
  const storeIcon = makeStoreIcon(pickupDone);

  // Cycling mode: AppUser preferred_travel_mode flag on the driver location,
  // or any active stop on today's route carrying a cycling transport_mode.
  const driverIsCycling = useMemo(() => {
    if (driverLocation?.cycling === true) return true;
    return routeDeliveries.some((d) =>
    !['completed', 'failed', 'cancelled'].includes(d.status) && d.transport_mode === 'cycling');
  }, [driverLocation?.cycling, routeDeliveries]);
  const driverMapIcon = useMemo(() => driverIsCycling ? cyclingDriverIcon : driverIcon, [driverIsCycling]);

  // Patient marker: colour based on delivery status / isNextDelivery, badge = stops before
  const patientIcon = makePatientIcon(todayDelivery?.status, todayDelivery?.isNextDelivery, stopsRemaining);

  // ── POLYLINE INTEGRITY (owner report Nov 3 2026) ─────────────────────────
  // Two portal-only artefacts, both from gluing leg polylines blindly:
  //   • STRAIGHT LINES where a leg has no polyline data — the merge pushed the
  //     next leg's points straight after the previous leg's end, so Leaflet drew
  //     one long straight chord across the gap.
  //   • ROAD LINES for stops that LEFT this driver's route (transferred to
  //     another driver) — their stored encoded_polyline survived in the local
  //     route snapshot and kept painting.
  // Fix: never concatenate across a gap. Each leg is decoded, VALIDATED against
  // the stop it belongs to, and painted as its own segment; a missing or stale
  // leg is a GAP (nothing drawn), never a chord.
  const pointGapMeters = (a, b) => {
    if (!a || !b) return Infinity;
    const lat1 = Number(a[0]),lng1 = Number(a[1]),lat2 = Number(b[0]),lng2 = Number(b[1]);
    if (![lat1, lng1, lat2, lng2].every(Number.isFinite)) return Infinity;
    const dy = (lat1 - lat2) * 110540;
    const dx = (lng1 - lng2) * 111320 * Math.cos((lat1 + lat2) / 2 * Math.PI / 180);
    return Math.sqrt(dx * dx + dy * dy);
  };

  // A leg is STALE when its polyline does not actually end at its own stop
  // (moved/transferred stop, polyline from a different route order). 200 m is
  // generous: real generated legs land on the stop.
  const legIsStale = (stop, coords) => {
    if (!Array.isArray(coords) || coords.length < 2) return true;
    const lat = Number(stop?.lat),lng = Number(stop?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat === 0 && lng === 0) return false; // can't judge
    return pointGapMeters(coords[coords.length - 1], [lat, lng]) > 200;
  };

  // Paint-ready segments: contiguous legs join only when they truly touch.
  const buildPolylineSegments = (stops) => {
    const segments = [];
    let current = null;
    for (const stop of stops) {
      const decoded = decodePolyline(stop.encoded_polyline);
      if (legIsStale(stop, decoded)) {current = null;continue;} // gap — draw nothing
      if (current && pointGapMeters(current[current.length - 1], decoded[0]) <= 40) {
        current.push(...decoded.slice(1));
      } else {
        current = decoded.slice();
        segments.push(current);
      }
    }
    return segments;
  };

  // Build route polylines split into:
  // 1. staticPolylineSegments — all legs EXCEPT the first stop's leg and the current leg (always visible)
  // 2. firstLegCoords — the leg from store → first stop (hidden when off duty / before 9:30)
  // 3. currentLegCoords — the leg leading to the driver's isNextDelivery stop (hidden when off duty / before 9:30)
  const { staticPolylineSegments, firstLegCoords, currentLegCoords } = useMemo(() => {
    if (!todayDelivery?.stop_order || routeDeliveries.length === 0) return { staticPolylineSegments: [], firstLegCoords: [], currentLegCoords: [] };
    const patientStopOrder = Number(todayDelivery.stop_order);
    const DONE_STATUSES = ['completed', 'failed', 'cancelled'];

    const relevantStops = routeDeliveries
    // DRIVER SCOPE: a stop transferred to another driver is not on this route
    // any more, no matter what the local snapshot still holds.
    .filter((d) => !d.driver_id || !todayDelivery.driver_id || d.driver_id === todayDelivery.driver_id).
    filter((d) => d.encoded_polyline && Number(d.stop_order) <= patientStopOrder && !DONE_STATUSES.includes(d.status)).
    sort((a, b) => Number(a.stop_order) - Number(b.stop_order));

    if (relevantStops.length === 0) return { staticPolylineSegments: [], firstLegCoords: [], currentLegCoords: [] };

    const firstStop = relevantStops[0];
    const minStopOrder = Number(firstStop.stop_order);

    // Current leg = stop with isNextDelivery=true
    const currentLegStop = relevantStops.find((d) => d.isNextDelivery === true);

    // Static = everything except first stop leg and current leg
    const staticStops = relevantStops.filter((d) =>
    Number(d.stop_order) !== minStopOrder && d.isNextDelivery !== true
    );

    // First leg = first stop only (unless it's also the current leg, then it's covered there)
    const firstLegStop = firstStop.isNextDelivery ? null : firstStop;

    return {
      staticPolylineSegments: buildPolylineSegments(staticStops),
      firstLegCoords: firstLegStop && !legIsStale(firstLegStop, decodePolyline(firstLegStop.encoded_polyline)) ?
      decodePolyline(firstLegStop.encoded_polyline) : [],
      currentLegCoords: currentLegStop && !legIsStale(currentLegStop, decodePolyline(currentLegStop.encoded_polyline)) ?
      decodePolyline(currentLegStop.encoded_polyline) : []
    };
  }, [routeDeliveries, todayDelivery?.stop_order, todayDelivery?.id, todayDelivery?.driver_id]);

  // Visible route path (owner spec Oct 23 2026): every leg the patient can
  // see on the map, flattened into one point list for bounds fitting — the
  // intermediate stops aren't rendered as markers, but their leg geometry keeps
  // them inside the pan/zoom frame. NOTE: the live-tracking gate is applied at
  // the prop site (showLiveTracking is defined below this memo — referencing it
  // here would be a TDZ error), so the fit never zooms out to include invisible
  // geometry.
  const ROUTE_COORDS_EMPTY = [];

  // STOP COORDINATES for the invisible intermediate stops (owner request Nov 3
  // 2026): the portal draws markers only for the driver, the pharmacy and this
  // patient, so the stops in between have to be resolved separately or the
  // pan/zoom frame never knew they existed and cropped them out of view.
  // Delivery rows usually carry no lat/lng (those live on the Patient record),
  // so missing ones are looked up here once per route change.
  const [routeStopCoords, setRouteStopCoords] = useState({});
  useEffect(() => {
    const missing = (routeDeliveries || []).
    filter((d) => d?.patient_id &&
    !(Number.isFinite(Number(d.lat)) && Number.isFinite(Number(d.lng))) &&
    !d.encoded_polyline).
    map((d) => String(d.patient_id));
    const ids = [...new Set(missing)];
    if (ids.length === 0) {setRouteStopCoords({});return undefined;}

    let alive = true;
    (async () => {
      const map = {};
      const record = (row) => {
        if (!row) return;
        const lat = Number(row.latitude);
        const lng = Number(row.longitude);
        if (Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0) {
          map[String(row.id)] = [lat, lng];
        }
      };
      try {
        const rows = await base44.entities.Patient.filter({ id: { $in: ids } }, '-updated_date', ids.length);
        (rows || []).forEach(record);
      } catch (_) {/* fall through to per-id reads */}
      for (const id of ids) {
        if (map[id]) continue;
        try {record(await base44.entities.Patient.get(id));} catch (_) {/* skip */}
      }
      if (alive) setRouteStopCoords(map);
    })();

    return () => {alive = false;};
  }, [routeDeliveries]);

  const visibleRouteCoords = useMemo(() => {
    // OWNER FIX (Oct 23 2026 — v1.9.65): the fit was anchored to leg ORIGIN
    // endpoints — coordinates of stops the driver had ALREADY FINISHED, sitting
    // behind the driver. Those dead anchors kept the frame wide and static
    // instead of following the marker.
    //
    // OWNER REQUEST (Nov 3 2026, second pass): stops that are NOT drawn on the
    // map must still hold the pan/zoom frame. Endpoint-only fitting kept missing
    // them (a stop's own record carries no coordinates, the patient lookup can
    // come back empty, and a pending stop has no leg polyline yet), so the frame
    // is now built from the PAINTED ROUTE ITSELF: every leg that is already drawn
    // between the driver and this patient is sampled into the fit. Whatever the
    // patient can see bent around an invisible stop, the frame now includes.
    const patientStopOrder = Number(todayDelivery?.stop_order);
    if (!todayDelivery) return [];

    // Sample a painted leg: first, last, and every Nth vertex between them.
    // 310-point legs are normal, so the stride keeps the array small without
    // letting a bend (which is exactly where an invisible stop sits) escape.
    const sampleLeg = (leg, out) => {
      if (!Array.isArray(leg) || leg.length < 2) return;
      const stride = Math.max(1, Math.ceil(leg.length / 40));
      for (let i = 0; i < leg.length; i += stride) out.push(leg[i]);
      out.push(leg[leg.length - 1]);
    };

    // ── BEHIND THE DRIVER IS NEVER IN FRAME (owner rule Nov 3 2026) ─────────
    // A leg's geometry STARTS at the stop before it, and that stop is usually the
    // one the driver just finished. Sampling the whole leg dragged that finished
    // stop back into the frame (owner report: the last completed stop was framing
    // the view). Only ACTIVE stops between the driver and this patient count, so
    // the leg the driver is on is trimmed at his own position and anything behind
    // him is dropped.
    const driverPoint = Number.isFinite(Number(driverLocation?.lat)) && Number.isFinite(Number(driverLocation?.lng)) ?
    [Number(driverLocation.lat), Number(driverLocation.lng)] :
    null;

    const trimBehindDriver = (leg) => {
      if (!Array.isArray(leg) || leg.length < 2) return [];
      if (!driverPoint) return []; // can't tell what is behind him — fit without this leg
      let nearest = 0;
      let nearestGap = Infinity;
      for (let i = 0; i < leg.length; i++) {
        const gap = pointGapMeters(leg[i], driverPoint);
        if (gap < nearestGap) {nearestGap = gap;nearest = i;}
      }
      return nearest >= leg.length - 1 ? [] : leg.slice(nearest);
    };

    const pts = [];
    // Legs beyond the current stop stay whole: they run from an ACTIVE stop to
    // an ACTIVE stop, so nothing finished is anchored.
    (staticPolylineSegments || []).forEach((leg) => sampleLeg(leg, pts));
    sampleLeg(trimBehindDriver(currentLegCoords), pts);
    // firstLegCoords (store → first stop) is deliberately NOT a fit source: it is
    // the leg behind the driver, the very "dead anchor" the Oct 23 fix removed.

    // Stop positions on top of the painted geometry: legs are painted only for
    // stops that already have one, so this still covers a stop the route has not
    // reached yet. Resolution order: own lat/lng, the patient record, the end of
    // its stored leg polyline, then its store's coordinates for a pickup.
    const storeCoords = {};
    (stores || []).forEach((st) => {
      const lat = Number(st?.latitude);
      const lng = Number(st?.longitude);
      if (Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0) storeCoords[String(st.id)] = [lat, lng];
    });

    const DONE = ['completed', 'failed', 'cancelled'];
    for (const d of routeDeliveries || []) {
      if (DONE.includes(d.status)) continue; // finished stop — never a fit point
      if (Number(d.stop_order) >= patientStopOrder) continue; // patient & later stops excluded

      let pt = null;
      if (Number.isFinite(Number(d.lat)) && Number.isFinite(Number(d.lng)) &&
      Number(d.lat) !== 0 && Number(d.lng) !== 0) {
        pt = [Number(d.lat), Number(d.lng)];
      }
      if (!pt && d.patient_id) pt = routeStopCoords[String(d.patient_id)] || null;
      if (!pt && d.encoded_polyline) {
        const leg = decodePolyline(d.encoded_polyline); // polyline ends at the stop
        if (leg.length > 0) pt = leg[leg.length - 1];
      }
      if (!pt && d.store_id) pt = storeCoords[String(d.store_id)] || null;
      if (pt) pts.push(pt);
    }
    return pts;
  }, [
  routeDeliveries,
  todayDelivery?.stop_order,
  todayDelivery?.id,
  routeStopCoords,
  stores,
  staticPolylineSegments,
  currentLegCoords,
  driverLocation?.lat,
  driverLocation?.lng]
  );

  const storeLatLng = activeStore?.latitude && activeStore?.longitude ?
  [activeStore.latitude, activeStore.longitude] :
  null;

  const defaultCenter = patient?.latitude && patient?.longitude ?
  [patient.latitude, patient.longitude] :
  [53.5461, -113.4938]; // Edmonton fallback

  const patientLatLng = patient?.latitude && patient?.longitude ?
  [patient.latitude, patient.longitude] :
  null;

  // Double-tap: resume tracking immediately (cancels any pending 10s timer).
  const handleDoubleTap = useCallback(() => {
    if (trackingResumeTimerRef.current) {
      clearTimeout(trackingResumeTimerRef.current);
      trackingResumeTimerRef.current = null;
    }
    setTrackingMode(true);
  }, []);
  // User zoomed/dragged: pause auto-fit, reactivate 10s later on its own.
  const handleUserInteract = useCallback(() => {
    setTrackingMode(false);
    if (trackingResumeTimerRef.current) clearTimeout(trackingResumeTimerRef.current);
    trackingResumeTimerRef.current = setTimeout(() => {
      trackingResumeTimerRef.current = null;
      setTrackingMode(true);
    }, 10000);
  }, []);

  // Live tracking is only visible after 9:30 AM and when driver is on_duty
  const isAfter930am = (() => {
    const now = new Date();
    return now.getHours() > 9 || now.getHours() === 9 && now.getMinutes() >= 30;
  })();
  // REMAINING STOPS (owner request Nov 3 2026): how many patient stops the
  // driver still has on today's route, shown under the status badge on the
  // current delivery card. Pickup containers (no patient_id) are excluded so
  // the number reads the same way the patient thinks about it.
  const liveRemainingStops = useMemo(() => {
    if (!todayDelivery?.id || stopsRemaining == null) return null;
    return { [todayDelivery.id]: stopsRemaining };
  }, [todayDelivery?.id, stopsRemaining]);

  // OWNER REQUEST (Nov 3 2026): a PENDING (not yet picked up) delivery still
  // shows the driver — an on-duty driver shows immediately whatever the clock,
  // and the 9:30am floor stays as the guard against an overnight stale fix.
  const isLiveDeliveryStatus = !!todayDelivery && LIVE_DRIVER_STATUSES.includes(todayDelivery.status);
  const showLiveTracking = !!driverLocation && isLiveDeliveryStatus && (driverStatus === 'on_duty' || isAfter930am);

  // SETTLED (owner rule Nov 3 2026): this patient's delivery is done — completed
  // or failed. From that moment the map frames the patient's home and the pickup
  // location only.
  const settledDelivery = !!todayDelivery && ['completed', 'failed'].includes(todayDelivery.status);

  // Unread pharmacy replies — badge on the header button. Refreshed on mount,
  // on focus and after the sheet closes; the sheet itself clears it on open.
  // Midnight rollover for the floating today card: re-read the calendar day
  // every minute so the card disappears the moment its date is no longer today.
  useEffect(() => {
    const tick = () => {
      const next = format(new Date(), 'yyyy-MM-dd');
      setLiveDay((prev) => prev === next ? prev : next);
    };
    const timer = setInterval(tick, 60000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, []);

  useEffect(() => {
    if (!patient?.id) return undefined;
    let cancelled = false;
    const refresh = async () => {
      const count = await loadPatientUnreadCount(patient.id);
      if (!cancelled) setUnreadMessages(count);
    };
    refresh();
    const timer = setInterval(refresh, 60000);
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [patient?.id, messagingOpen]);

  return (
    // Height: 100dvh on phones/tablets so the layout stops at the DEVICE
    // navigation bar instead of running underneath it (100vh includes the area
    // behind the OS bar). Owner report Nov 2 2026: the sidebar footer was
    // slipping behind the nav bar on wider screens.
    <div
      className={`relative flex ${embedded ? 'h-full' : 'h-screen'} bg-slate-100 dark:bg-slate-800 overflow-hidden`}
      style={embedded ? undefined : { height: '100dvh' }}>
      
      <PatientPortalGuard />
      <PWAInstallPrompt storageKey="patient_pwa_install_dismissed" />

      {/* Sidebar */}
      <PatientSidebar
        patient={patient}
        deliveries={deliveries}
        pickupStops={pickupStops}
        puidGroups={puidGroups}
        stores={stores}
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        embedded={embedded}
        liveRemainingStops={liveRemainingStops} />
      

      {/* Main Content */}
      <div className="flex-1 flex flex-col md:ml-72 overflow-hidden">

        {/* Top Bar */}
        <div
          className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-700 flex items-center gap-3 flex-shrink-0 z-10 py-4 px-4"
          style={{ paddingTop: embedded ? '0.75rem' : 'calc(0.75rem + var(--native-safe-top, env(safe-area-inset-top, 0px)))' }}>
          
          <button
            onClick={() => setSidebarOpen(true)}
            className="md:hidden w-9 h-9 rounded-lg bg-slate-100 dark:bg-slate-800 flex items-center justify-center">
            
            <Menu className="w-5 h-5 text-slate-600 dark:text-slate-400" />
          </button>
          <div className="flex items-center gap-2">
            <HeartPulse className="w-5 h-5 text-slate-700 dark:text-slate-300 hidden md:block" />
            <div>
              <h1 className="text-sm font-bold text-slate-900 dark:text-slate-100">My Deliveries</h1>
              <p className="text-xs text-slate-400 dark:text-slate-400">{format(new Date(), 'EEEE, MMMM d')}</p>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {/* EXIT PATIENT VIEW — NARROW SCREENS (owner request Nov 3 2026): the
                   floating card button took up card space on phones, so up here it
                   fills the gap between the title and the icons and shows just the
                   word Exit. md:hidden keeps the card button for wide layouts. */}
            {canExitPreview &&
            <button
              onClick={() => requestExitPatientView()}
              className="md:hidden shrink-0 flex items-center justify-center px-2.5 py-1.5 rounded-lg text-[11px] font-semibold text-white shadow-sm transition-colors"
              style={{ background: '#1e40af' }}
              title="Exit Patient View"
              aria-label="Exit Patient View">
              
                Exit
              </button>
            }
            {/* Live connection indicator */}
            {liveConnected &&
            <div className="hidden sm:flex items-center gap-1.5 text-xs text-green-600 font-medium">
                <Wifi className="w-3.5 h-3.5" />
                <span>Live</span>
              </div>
            }
            {/* NOTIFICATIONS CONTROL (owner request Nov 3 2026) — the permanent way
                for a patient to turn push on or off on this device, whatever state
                the one-off prompt left them in. */}
            <PatientNotificationToggle patient={patient} />
            <button
              onClick={() => setMessagingOpen(true)}
              data-patient-msg-btn="1"
              className="relative w-9 h-9 rounded-lg bg-slate-100 dark:bg-slate-800 flex items-center justify-center hover:bg-slate-200 transition-colors"
              title="Messages"
              aria-label="Messages">
              
              <MessageSquare className="w-4 h-4 text-slate-500 dark:text-slate-400" />
              {unreadMessages > 0 &&
              <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-red-600 text-white text-[10px] font-bold flex items-center justify-center">
                  {unreadMessages > 9 ? '9+' : unreadMessages}
                </span>
              }
            </button>
            {/* WEB-UPDATE BALLOON (owner request Nov 3 2026) — identical look
                   and rhythm to the staff balloon, anchored to this refresh
                   button. Tapping it reloads onto the new build. */}
            <UpdateInfoBalloon
              active={!!hasWebUpdate}
              anchorSelector="[data-patient-update-btn]"
              direction="down"
              accent="#10b981"
              icon="⬆️"
              title="Update available"
              message="A new version of the patient portal is ready. Tap here to install it now."
              cta="Tap to install update"
              onClick={() => {void applyPortalUpdate();}} />
            
            {/* REFRESH / UPDATE BUTTON (owner clarification Nov 3 2026): with an
                   update waiting this is a FULL APP RESTART onto the new build
                   (same purge as the staff "Clear Cache & Refresh"), not a data
                   refresh — the live data already arrives over the websocket, so a
                   data-only tap looked like it did nothing. With no update waiting
                   it stays a plain data refresh. */}
            <button
              data-patient-update-btn
              onClick={() => {
                if (hasWebUpdate) {
                  setUpdating(true);
                  void applyPortalUpdate();
                  return;
                }
                try {setUpdating(true);} catch {/* ignore */}
                loadData().finally(() => setUpdating(false));
              }}
              className="relative w-9 h-9 rounded-lg bg-slate-100 dark:bg-slate-800 flex items-center justify-center hover:bg-slate-200 transition-colors"
              title={hasWebUpdate ? 'Update available — tap to install' : 'Refresh'}
              aria-label={hasWebUpdate ? 'Update and restart' : 'Refresh'}>
              
              <RefreshCw className={`w-4 h-4 text-slate-500 dark:text-slate-400 ${updating ? 'animate-spin' : ''}`} />
              {/* Green update dot (owner request Nov 3 2026): the same cue the
                     staff update arrow gives, so a patient knows why the balloon
                     keeps appearing. */}
              {hasWebUpdate &&
              <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-emerald-500 ring-2 ring-white dark:ring-slate-900" />
              }
            </button>
          </div>
        </div>

        <PatientNotifyPrompt patient={patient} />

        {/* Map */}
        <div
          className="flex-1 overflow-hidden relative pt-2 pr-2 pl-2 pb-1"
          style={{ paddingBottom: embedded ? '1rem' : 'calc(1rem + var(--native-safe-bottom, env(safe-area-inset-bottom, 0px)))' }}>
          
          {/* TODAY'S DELIVERY — floating top-left (owner request Nov 2 2026).
                 Only while the sidebar is hidden (phones, or the drawer closed), and
                 only while the delivery date is TODAY: todayDelivery is resolved for
                 TODAY only, so tomorrow this card simply stops rendering and the
                 delivery lives in the sidebar history. */}
          {showFloatTodayCard &&
          <div className="absolute top-2 left-2 z-[900] md:hidden">
              <PatientTodayFloatingCard
              delivery={todayDelivery}
              pickupStops={pickupStops}
              puidGroups={puidGroups}
              stores={stores}
              onCollapsedHeight={setFloatCardHeight}
              remainingStops={liveRemainingStops?.[todayDelivery.id] ?? null} />
            
            </div>
          }

          {/* Tracking badge — BOTTOM CENTER (owner request Nov 2 2026, moved
                 down from the top centre so it no longer overlaps the floating
                 today card or the header controls). */}
          {showLiveTracking && driverLocation &&
          <div className="absolute bottom-2 left-1/2 -translate-x-1/2 z-[1000] pointer-events-none">
              <div className={`text-xs font-medium px-3 py-1 rounded-full shadow border ${trackingMode ? 'bg-green-50 dark:bg-green-950 text-green-700 border-green-200' : 'bg-white dark:bg-slate-900 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-700'}`}>
                {trackingMode ? '📍 Tracking driver' : '⏳ Tracking resumes shortly'}
              </div>
            </div>
          }
          <div className="h-full rounded-xl overflow-hidden border border-slate-200 dark:border-slate-700 shadow-sm relative">
            {/* Map centre crosshair — same overlay the main dashboard map uses.
                   Sits at the centre of the SAME padded region the auto-fit uses
                   (left/right 20, top clears the floating today card, bottom 35),
                   so it marks the exact point the fit is centred on. */}
            <MapCrosshair topPadding={mapPad.top} bottomPadding={mapPad.bottom} zClass="z-[600]" />
            <MapContainer
              center={defaultCenter}
              zoom={13}
              style={{ height: '100%', width: '100%' }}
              zoomControl={false}
              // OWNER FIX (Oct 23 2026): Leaflet's default zoomSnap=1 rounds
              // EVERY zoom change to whole numbers — the auto-fit computed the
              // exact fractional zoom for a 50px buffer, then setView snapped
              // it to the nearest integer: one way the markers bounced off
              // screen, the other way a huge gap appeared at top/bottom. Free
              // zoom: the fit parks at its exact computed level and manual
              // pinch/scroll no longer jumps whole levels either.
              zoomSnap={0}>
              
              <TileLayer
                key={tileUrl}
                url={tileUrl}
                className={hereApiKey ? '' : isDarkTheme ? 'portal-osm-dark' : ''}
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://www.here.com/">HERE</a>'
                tileSize={hereApiKey ? 512 : 256}
                zoomOffset={hereApiKey ? -1 : 0}
                maxNativeZoom={17} />
              

              <MapBoundsFitter
                patientLatLng={patientLatLng}
                storeLatLng={storeLatLng}
                driverLatLng={driverLocation ? [driverLocation.lat, driverLocation.lng] : null}
                showDriver={showLiveTracking && !!driverLocation}
                routeCoords={showLiveTracking ? visibleRouteCoords : ROUTE_COORDS_EMPTY}
                mapPad={mapPad}
                settledOnly={settledDelivery} />
              
              <DriverTracker
                driverLocation={showLiveTracking ? driverLocation : null}
                driverPaintPos={driverPaintPos}
                patientLatLng={patientLatLng}
                trackingMode={settledDelivery ? false : trackingMode}
                onDoubleTap={handleDoubleTap}
                onUserInteract={handleUserInteract}
                routeCoords={showLiveTracking ? visibleRouteCoords : ROUTE_COORDS_EMPTY}
                mapPad={mapPad} />
              

              {/* Remaining legs (between the driver and the patient) — solid green, always visible */}
              {staticPolylineSegments.map((segment, segIdx) =>
              segment.length > 1 &&
              <Polyline
                key={`static-leg-${segIdx}`}
                positions={segment}
                pathOptions={{ color: routeLegColor, weight: 4, opacity: 0.85 }} />


              )}

              {/* First stop leg (store → first stop) — solid green — hidden when off duty or before 9:30 AM */}
              {showLiveTracking && firstLegCoords.length > 1 &&
              <Polyline
                positions={firstLegCoords}
                pathOptions={{ color: routeLegColor, weight: 4, opacity: 0.85 }} />

              }

              {/* Current leg (driver → isNextDelivery stop) — solid blue like the driver dashboard */}
              {showLiveTracking && currentLegCoords.length > 1 &&
              <Polyline
                positions={currentLegCoords}
                pathOptions={{ color: currentLegColor, weight: 5, opacity: 0.95 }} />

              }

              {/* Store marker */}
              {activeStore?.latitude && activeStore?.longitude &&
              <Marker position={[activeStore.latitude, activeStore.longitude]} icon={storeIcon}>
                  <Popup><strong>{activeStore.name}</strong><br />{activeStore.address}</Popup>
                </Marker>
              }

              {/* Patient location marker */}
              {patient?.latitude && patient?.longitude &&
              <Marker position={[patient.latitude, patient.longitude]} icon={patientIcon}>
                  <Popup><strong>Your Address</strong><br />{patient.address}</Popup>
                </Marker>
              }

              {/* Driver marker — only when live tracking is enabled. Glides smoothly
                     between 15s location updates (same trail interpolation as the shared
                     driver dots on dispatcher maps) instead of teleporting. */}
              {showLiveTracking && driverLocation &&
              <AnimatedDriverMarker driverLocation={driverLocation} legCoords={currentLegCoords} icon={driverMapIcon} onPaint={handleDriverPaint}>
                  <Popup><strong>Your Driver</strong><br />{driverLocation.name || 'On the way!'}</Popup>
                </AnimatedDriverMarker>
              }
            </MapContainer>
          </div>
        </div>
      </div>

      <PatientMessaging
        patient={patient}
        stores={stores}
        open={messagingOpen}
        onClose={() => setMessagingOpen(false)}
        onUnreadChange={setUnreadMessages} />
      
    </div>);

}