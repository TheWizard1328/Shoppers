import React, { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Phone, Navigation, Pen, Camera, Eye, DollarSign, StickyNote } from "lucide-react";
import { isAppOwner, userHasRole, shouldShowStoreBadges } from "../utils/userRoles";
import { getStoreColor } from "../utils/colorGenerator";
import { getCurrentEtaForDelivery } from "../utils/etaTrendBus";
import { useInterStoreDisplayName, isInterStoreDelivery } from "../utils/interStoreDisplayName";
import { getCyclingMarkerDisplayInfo } from "../utils/deliveryTypeUtils";

// ── helpers ─────────────────────────────────────────────────────────────────

function extractStoredTime(value) {
  if (!value) return null;
  const raw = String(value);
  const hasTimezoneSuffix = /Z$|[+-]\d{2}:?\d{2}$/.test(raw);
  if (hasTimezoneSuffix) {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) {
      return `${String(parsed.getHours()).padStart(2, "0")}:${String(parsed.getMinutes()).padStart(2, "0")}`;
    }
  }
  const isoMatch = raw.match(/T(\d{2}:\d{2})/);
  if (isoMatch) return isoMatch[1];
  const timeMatch = raw.match(/^(\d{2}:\d{2})/);
  if (timeMatch) return timeMatch[1];
  return null;
}

function fmt(t) {
  if (!t || ["--:--", "null", "undefined", "NaN:NaN"].includes(String(t))) return "--:--";
  try {
    const norm = extractStoredTime(t) || String(t);
    const [h, m] = norm.split(":");
    const hh = parseInt(h, 10);
    const mm = parseInt(m, 10);
    if (isNaN(hh) || isNaN(mm)) return "--:--";
    return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  } catch {
    return "--:--";
  }
}

const FINISHED = ["completed", "failed", "cancelled"];

const statusConfig = {
  pending: { label: "Pending", cls: "bg-slate-500" },
  in_transit: { label: "In Transit", cls: "bg-blue-500" },
  en_route: { label: "En Route", cls: "bg-cyan-500" },
  completed: { label: "Complete", cls: "bg-emerald-500" },
  failed: { label: "Failed", cls: "bg-red-500" },
  cancelled: { label: "Cancelled", cls: "bg-red-500" },
  returned: { label: "Return", cls: "bg-orange-500" },
};

// ── component ────────────────────────────────────────────────────────────────

export default function RouteManagementMobileCard({
  delivery,
  patient,
  store,
  currentUser,
  isPickup,
  onClick,
  isSelected,
}) {
  const [viewingImageUrl, setViewingImageUrl] = useState(null);
  const ispDisplayName = useInterStoreDisplayName(delivery?.delivery_id);

  if (!delivery) return null;

  const isFinished = FINISHED.includes(delivery.status);
  const storeColor = store ? getStoreColor(store) : "#64748b";
  const showStoreBadge = shouldShowStoreBadges(currentUser);

  // ── Row 1 data ──────────────────────────────────────────────────────────
  const stopNum = delivery.display_stop_order ?? delivery.stop_order ?? "";
  const trackingNum = delivery.tracking_number ? parseInt(delivery.tracking_number) || 0 : null;
  const storeAbbr = store?.abbreviation ? store.abbreviation.slice(0, 2).toUpperCase() : null;
  const sid = delivery.stop_id || null;

  const trLabel = trackingNum != null ? String(trackingNum).padStart(trackingNum > 99 ? 3 : 2, "0") : null;

  const statusInfo = statusConfig[delivery.status] || { label: delivery.status, cls: "bg-slate-500" };

  const timeDisplay = (() => {
    if (isFinished) {
      const actual = fmt(delivery.actual_delivery_time);
      const arrival = fmt(delivery.arrival_time);
      const hasActual = actual !== "--:--";
      const hasArrival = arrival !== "--:--";
      if (hasArrival || hasActual) {
        return hasArrival && hasActual ? `${arrival}→${actual}` : hasArrival ? arrival : actual;
      }
      return null;
    }
    const eta = getCurrentEtaForDelivery(
      delivery.id,
      delivery.delivery_time_eta || delivery.delivery_time_start || null
    );
    const etaFmt = fmt(eta);
    return etaFmt !== "--:--" ? `ETA ${etaFmt}` : null;
  })();

  // ── Row 2 data ──────────────────────────────────────────────────────────
  const cycling = getCyclingMarkerDisplayInfo(delivery);
  const displayName = cycling.isCyclingMarker
    ? cycling.cyclingName
    : isInterStoreDelivery(delivery.delivery_id) && ispDisplayName
      ? ispDisplayName
      : isPickup
        ? store?.name || "Pickup"
        : patient?.full_name || delivery.patient_name || "Unknown";

  const codRequired = delivery.cod_total_amount_required || 0;
  const codCollected = (delivery.cod_payments || []).reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
  const hasCOD = codRequired > 0;
  const codComplete = codCollected >= codRequired;

  // ── Row 3 data ──────────────────────────────────────────────────────────
  const address = isPickup ? store?.address : patient?.address;
  const phone = isPickup ? store?.phone : patient?.phone || delivery.patient_phone;

  const lat = isPickup ? store?.latitude : patient?.latitude;
  const lng = isPickup ? store?.longitude : patient?.longitude;
  const navHref =
    lat && lng
      ? `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`
      : null;

  // ── Row 4 data ──────────────────────────────────────────────────────────
  const hasSig = !!delivery.signature_image_url;
  const photos = Array.isArray(delivery.proof_photo_urls) ? delivery.proof_photo_urls : [];
  // Pickups use receipt_barcode_values; deliveries use barcode_values
  const barcodeSource = isPickup
    ? delivery.receipt_barcode_values
    : delivery.barcode_values;
  const firstBarcode =
    Array.isArray(barcodeSource) && barcodeSource.length > 0
      ? barcodeSource[0]
      : null;

  const borderColor = delivery.isNextDelivery ? "#10B981" : "#3B82F6";

  // ── Computed row data ─────────────────────────────────────────────────
  const codPayments = Array.isArray(delivery.cod_payments) ? delivery.cod_payments : [];
  const hasCODRow = codRequired > 0 || codPayments.length > 0;

  const arrivalTime = fmt(delivery.arrival_time);
  const hasArrival = arrivalTime !== "--:--";
  const timeAtLocation = (() => {
    if (hasArrival) return arrivalTime;
    if (delivery.status === "in_transit" || delivery.status === "en_route") {
      const eta = fmt(getCurrentEtaForDelivery(delivery.id, delivery.delivery_time_eta || delivery.delivery_time_start || null));
      return eta !== "--:--" ? `ETA ${eta}` : null;
    }
    return null;
  })();

  const actualTime = fmt(delivery.actual_delivery_time);
  const statusLabel = isFinished && actualTime !== "--:--" ? `${statusInfo.label} ${actualTime}` : statusInfo.label;

  // Address (with unit for patients)
  const addrLine = isPickup
    ? store?.address
    : [patient?.address, patient?.unit_number ? `Unit ${patient.unit_number}` : null].filter(Boolean).join(", ");

  const phoneSecondary = isPickup ? null : patient?.phone_secondary;
  const patientNotes = isPickup ? null : patient?.notes;
  const driverNotes = delivery.delivery_notes;

  const barcodes = Array.isArray(barcodeSource) ? barcodeSource : [];

  return (
    <>
      {/* Fullscreen image viewer */}
      {viewingImageUrl && (
        <div
          className="fixed inset-0 flex items-center justify-center p-4 z-[999999]"
          style={{ background: "rgba(0,0,0,0.75)" }}
          onClick={() => setViewingImageUrl(null)}
        >
          <div
            className="relative bg-white dark:bg-slate-900 rounded-xl shadow-2xl p-4 max-w-[95vw] max-h-[90vh] flex flex-col items-center"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setViewingImageUrl(null)}
              className="absolute -top-3 -right-3 bg-white dark:bg-slate-900 border-2 border-slate-300 dark:border-slate-600 rounded-full w-9 h-9 flex items-center justify-center shadow-lg"
            >
              ✕
            </button>
            <img
              src={viewingImageUrl}
              alt="Proof of delivery"
              className="max-w-full max-h-[75vh] object-contain rounded-lg"
            />
          </div>
        </div>
      )}

      <div
        className={`w-full rounded-xl border-2 shadow-md cursor-pointer transition-all overflow-hidden ${
          isSelected ? "ring-2 ring-blue-500" : ""
        }`}
        style={{
          background: "var(--bg-white)",
          borderColor,
          opacity: 1,
        }}
        onClick={() => onClick?.(delivery)}
      >
        <div className="px-3 py-2 flex flex-col gap-1.5">

          {/* ── Row 1: Stop# • TR# (left) | Store badge • Time • Status+time (right) ── */}
          <div className="flex items-center justify-between gap-1 min-w-0">
            <div className="flex items-center gap-1 flex-shrink-0 min-w-0">
              <Badge
                className="text-xs font-bold px-1.5 py-0.5 rounded-full text-white"
                style={{ backgroundColor: storeColor }}
              >
                #{stopNum}
              </Badge>
              {trLabel && (
                <>
                  <span className="text-slate-400 dark:text-slate-500 text-xs">•</span>
                  <span className="text-xs font-semibold" style={{ color: "var(--text-slate-600)" }}>
                    {trLabel}
                  </span>
                </>
              )}
            </div>

            <div className="flex items-center gap-1 flex-shrink-0 ml-auto">
              {showStoreBadge && (storeAbbr || sid) && (
                <Badge
                  className="text-xs font-bold px-1.5 py-0.5 rounded-full text-white flex-shrink-0"
                  style={{ backgroundColor: storeColor }}
                >
                  {storeAbbr && sid ? `${storeAbbr} • ${sid}` : storeAbbr || sid}
                </Badge>
              )}
              {timeAtLocation && (
                <span className="text-xs font-semibold" style={{ color: "var(--text-slate-600)" }}>
                  {timeAtLocation}
                </span>
              )}
              <Badge className={`text-xs font-bold px-2 py-0.5 rounded-full text-white ${statusInfo.cls}`}>
                {statusLabel}
              </Badge>
            </div>
          </div>

          {/* ── Row 2: Name + Address & Unit ── */}
          {(displayName || addrLine) && (
            <div className="flex items-baseline gap-1.5 min-w-0">
              {displayName && (
                <span className="text-sm font-semibold truncate" style={{ color: "var(--text-slate-900)" }}>
                  {displayName}
                </span>
              )}
              {addrLine && navHref ? (
                <a
                  href={navHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="text-xs text-blue-600 dark:text-blue-400 underline truncate flex-1 min-w-0 flex items-center gap-1"
                >
                  <Navigation className="w-3 h-3 flex-shrink-0" />
                  {addrLine}
                </a>
              ) : addrLine ? (
                <span className="text-xs truncate flex-1 min-w-0" style={{ color: "var(--text-slate-600)" }}>
                  {addrLine}
                </span>
              ) : null}
            </div>
          )}

          {/* ── Row 3: Phone numbers ── */}
          {(phone || phoneSecondary) && (
            <div className="flex flex-wrap items-center gap-2 min-w-0">
              {phone && (
                <a
                  href={`tel:${String(phone).replace(/\D/g, "")}`}
                  onClick={(e) => e.stopPropagation()}
                  className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400 font-medium"
                >
                  <Phone className="w-3 h-3" />
                  {phone}
                </a>
              )}
              {phoneSecondary && (
                <a
                  href={`tel:${String(phoneSecondary).replace(/\D/g, "")}`}
                  onClick={(e) => e.stopPropagation()}
                  className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400 font-medium"
                >
                  <Phone className="w-3 h-3" />
                  {phoneSecondary}
                </a>
              )}
            </div>
          )}

          {/* ── Row 4: COD info (single row) ── */}
          {hasCODRow && (
            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs" style={{ color: "var(--text-slate-700)" }}>
              <span className="font-medium flex items-center gap-1" style={{ color: "var(--text-slate-500)" }}>
                <DollarSign className="w-3 h-3" /> COD Payment:
              </span>
              {codRequired > 0 && (
                <span className="font-medium">Required: ${codRequired.toFixed(2)}</span>
              )}
              {codPayments.map((p, idx) => (
                <span key={idx} className="contents">
                  <span style={{ color: "var(--text-slate-400)" }}>-</span>
                  <Badge variant="secondary" className="text-xs" style={{ background: "var(--bg-slate-100)", color: "var(--text-slate-700)" }}>
                    {p.type}: ${Number(p.amount || 0).toFixed(2)}
                  </Badge>
                </span>
              ))}
            </div>
          )}

          {/* ── Row 5: Patient Notes ── */}
          {patientNotes && (
            <div className="flex items-start gap-1 min-w-0">
              <StickyNote className="w-3 h-3 mt-0.5 flex-shrink-0" style={{ color: "var(--text-slate-400)" }} />
              <p className="text-xs whitespace-pre-wrap break-words" style={{ color: "var(--text-slate-700)" }}>
                <span className="font-medium">Patient Notes:</span> {patientNotes}
              </p>
            </div>
          )}

          {/* ── Row 6: Driver Notes ── */}
          {driverNotes && (
            <div className="flex items-start gap-1 min-w-0">
              <StickyNote className="w-3 h-3 mt-0.5 flex-shrink-0" style={{ color: "var(--text-slate-400)" }} />
              <p className="text-xs whitespace-pre-wrap break-words" style={{ color: "var(--text-slate-700)" }}>
                <span className="font-medium">Driver Notes:</span> {driverNotes}
              </p>
            </div>
          )}

          {/* ── Row 7: POD & Barcodes ── */}
          {(hasSig || photos.length > 0 || barcodes.length > 0) && (
            <div className="flex flex-wrap items-center gap-1.5">
              {hasSig && (
                <button
                  onClick={(e) => { e.stopPropagation(); setViewingImageUrl(delivery.signature_image_url); }}
                  className="w-7 h-7 rounded border border-emerald-400 bg-emerald-50 dark:bg-emerald-900/30 flex items-center justify-center"
                  title="View signature"
                >
                  <Pen className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-400" />
                </button>
              )}
              {photos.map((url, i) => (
                <button
                  key={i}
                  onClick={(e) => { e.stopPropagation(); setViewingImageUrl(url); }}
                  className="w-7 h-7 rounded border border-emerald-400 bg-emerald-50 dark:bg-emerald-900/30 flex items-center justify-center"
                  title="View photo"
                >
                  <Camera className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-400" />
                </button>
              ))}
              {barcodes.map((bc, i) => (
                <button
                  key={i}
                  onClick={(e) => { e.stopPropagation(); setViewingImageUrl(`https://barcodeapi.org/api/128/${encodeURIComponent(bc)}`); }}
                  className="flex items-center gap-1 text-xs text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 rounded px-1.5 py-0.5 bg-slate-50 dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700"
                  title="View barcode"
                >
                  <Eye className="w-3 h-3" />
                  <span className="font-mono truncate max-w-[90px]">{bc}</span>
                </button>
              ))}
            </div>
          )}

        </div>
      </div>
    </>
  );
}