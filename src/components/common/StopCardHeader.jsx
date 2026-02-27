import React from "react";
import { Badge } from "@/components/ui/badge";
import SpecialSymbolsBadges from "../utils/SpecialSymbolsBadges";
import { getDriverDisplayName } from "../utils/driverUtils";
import { calculateDeliveryPay, formatPay } from "../utils/payCalculator";
import { userHasRole } from "../utils/userRoles";
import { format } from "date-fns";

// Lightweight ETA override bus to reflect real-time ETA updates without full data reloads
const etaBus = (() => {
  if (typeof window === 'undefined') return { map: new Map(), version: 0 };
  if (!window.__etaBus) {
    window.__etaBus = { map: new Map(), version: 0 };
    window.addEventListener('etaUpdated', (e) => {
      try {
        const updates = (e?.detail?.updates) || [];
        updates.forEach((u) => {
          const id = u?.deliveryId || u?.delivery_id;
          if (id && u?.newEta) window.__etaBus.map.set(id, u.newEta);
        });
        window.__etaBus.version++;
      } catch (_) {}
    });
  }
  return window.__etaBus;
})();

// Local status labels (mirrors StopCard)
const statusConfig = {
  pending: { label: "Pending" },
  in_transit: { label: "In Transit" },
  en_route: { label: "En Route" },
  next: { label: "Next" },
  completed: { label: "Complete" },
  delivered: { label: "Complete" },
  failed: { label: "Failed" },
  cancelled: { label: "Cancelled" },
  returned: { label: "Return" },
};

function formatTime12Hour(timeString) {
  if (!timeString || ["--:--", "null", "undefined", "NaN:NaN"].includes(String(timeString))) return "--:--";
  try {
    const [h, m] = String(timeString).split(":");
    const hours = parseInt(h, 10);
    const minutes = parseInt(m, 10);
    if (isNaN(hours) || isNaN(minutes)) return "--:--";
    const period = hours >= 12 ? "PM" : "AM";
    const displayHours = hours % 12 || 12;
    return `${displayHours}:${String(minutes).padStart(2, "0")} ${period}`;
  } catch {
    return "--:--";
  }
}

export default function StopCardHeader({
  delivery,
  store,
  patient,
  isPickup,
  pendingPickups = [],
  storeColor,
  finalDisplayName,
  FINISHED_STATUSES,
  showDriverName,
  safeDriver,
  driverBadgeColor,
  driverBadgeTextColor,
  currentUser,
  appUsers = [],
  isReturnDelivery,
}) {
  // Subscribe to ETA bus to trigger re-render on updates
  const [etaVersion, setEtaVersion] = React.useState(etaBus.version);
  React.useEffect(() => {
    const handler = () => setEtaVersion(etaBus.version);
    window.addEventListener('etaUpdated', handler);
    return () => window.removeEventListener('etaUpdated', handler);
  }, []);
  const isFinished = FINISHED_STATUSES.includes(delivery?.status);

  const timeDisplay = (() => {
    if (isFinished && delivery?.actual_delivery_time) {
      return (
        <>
          <span className="font-medium">{formatTime12Hour(format(new Date(delivery.actual_delivery_time), "HH:mm"))}</span>
        </>
      );
    }
    // Prefer real-time ETA override from bus if available
    const overrideEta = etaBus.map.get(delivery?.id);
    const eta = overrideEta || delivery?.delivery_time_eta || (isPickup ? delivery?.delivery_time_start : null) || delivery?.delivery_time_start || "--:--";
    return <span className="font-medium">ETA: {formatTime12Hour(eta)}</span>;
  })();

  const statusLabel = isReturnDelivery ? "Return" : (statusConfig[delivery?.status]?.label || delivery?.status);
  const statusBgClass = isReturnDelivery
    ? "bg-orange-500"
    : (delivery?.status === "failed" || delivery?.status === "cancelled" ? "bg-red-500" : "bg-emerald-500");

  // Driver pay (for finished stops shown to drivers/admins)
  const showDriverPay = isFinished && (userHasRole(currentUser, "driver") || userHasRole(currentUser, "admin")) && (delivery?.patient_id || delivery?.after_hours_pickup);
  let payBadge = null;
  if (showDriverPay) {
    let driverAppUser = null;
    if (appUsers && appUsers.length > 0) {
      if (userHasRole(currentUser, "admin")) driverAppUser = appUsers.find((au) => au?.user_id === delivery?.driver_id);
      else driverAppUser = appUsers.find((au) => au?.user_id === currentUser?.id);
    }
    if (!driverAppUser && safeDriver && safeDriver.pay_rate_per_delivery) driverAppUser = safeDriver;

    const pay = driverAppUser ? calculateDeliveryPay(delivery, driverAppUser, patient) : 0;
    const baseRate = driverAppUser?.pay_rate_per_delivery || 0;
    const isAfterHours = delivery?.after_hours_pickup === true;
    const hasExtraPay = pay > baseRate && !isAfterHours;
    const isNoCharge = delivery?.no_charge === true;
    const payDisplay = isNoCharge ? 'N/C' : formatPay(pay);

    payBadge = !isAfterHours && !hasExtraPay ? (
      <div className="text-xm font-bold text-emerald-600">{payDisplay}</div>
    ) : (
      <Badge variant="secondary" className="inline-flex items-center border transition-colors text-xm font-bold px-2 py-0.5 rounded-full bg-green-200 !text-gray-800">
        {payDisplay}
      </Badge>
    );
  }

  return (
    <>
      {/* Left badges column */}
      <div className="flex flex-col py-0. gap-0.5  items-center">
        <Badge
          variant="secondary"
          className="bg-secondary text-white mt-1 px-2 py-0.5 text-sm font-bold rounded-full inline-flex items-center border transition-colors w-[40px] justify-center"
          style={{ backgroundColor: storeColor || "#10B981", color: "white" }}
        >
          #{delivery?.display_stop_order || delivery?.stop_order || 0}
        </Badge>

        {isPickup && pendingPickups && pendingPickups.length > 0 && (
          <Badge
            variant="secondary"
            className="bg-purple-500 text-secondary-foreground mt-1 px-2 text-sm font-bold rounded-lg inline-flex items-center border !text-white justify-center"
          >
            P: {pendingPickups.length}
          </Badge>
        )}

        <SpecialSymbolsBadges delivery={delivery} patient={patient} isPickup={isPickup} size="card" className="mt-1" />
      </div>

      {/* Center section */}
      <div className="flex-1 min-w-0">
        <h3 className="pt-0 text-2xl md:text-xl font-semibold text-center truncate" style={{ color: "var(--text-slate-900)" }}>
          {finalDisplayName}
        </h3>
        <div className="flex flex-col items-center min-h-[40px]">
          <div className="text-lg md:text-sm flex items-center justify-center" style={{ color: "var(--text-slate-600)" }}>
            {timeDisplay}
            {showDriverName && safeDriver && (
              <>
                <span className="px-1 py-0.5 text-xs font-semibold opacity-60 rounded-full inline-flex items-center" style={{ color: "var(--text-slate-500)" }}>
                  •
                </span>
                <Badge
                  variant="secondary"
                  className="inline-flex items-center px-2 py-0.5 rounded-full text-xs !text-white font-semibold"
                  style={{ backgroundColor: driverBadgeColor, color: driverBadgeTextColor }}
                >
                  {getDriverDisplayName(safeDriver)}
                </Badge>
              </>
            )}
          </div>

          {/* Time window for active stops */}
          {!isFinished && (delivery?.delivery_time_start || delivery?.delivery_time_end) && (
            <div className="text-sm md:text-[11px]" style={{ color: "var(--text-slate-500)" }}>
              {delivery?.delivery_time_start && delivery?.delivery_time_end ? (
                <>
                  {formatTime12Hour(delivery.delivery_time_start)} → {formatTime12Hour(delivery.delivery_time_end)}
                </>
              ) : delivery?.delivery_time_start ? (
                <>{formatTime12Hour(delivery.delivery_time_start)} →</>
              ) : delivery?.delivery_time_end ? (
                <>← {formatTime12Hour(delivery.delivery_time_end)}</>
              ) : null}
            </div>
          )}

          {showDriverPay && payBadge}
        </div>
      </div>

      {/* Right column */}
      <div className="flex flex-col py-0.5 gap-0.5 items-center">
        <div className="flex items-center gap-1">
          <Badge
            variant="secondary"
            className={`text-secondary-foreground mt-1 px-2 text-sm font-bold rounded-full ${statusBgClass}`}
            style={{ color: isPickup && delivery?.after_hours_pickup && isFinished ? "#3b82f6" : "white" }}
          >
            {statusLabel}
          </Badge>
        </div>

        {delivery?.tracking_number && store?.abbreviation && (
          <Badge
            variant="secondary"
            className="bg-secondary text-secondary-foreground mt-1 px-2 py-0.5 text-sm font-bold rounded-full inline-flex items-center"
            style={{ backgroundColor: `${storeColor}`, color: `White` }}
          >
            {(() => {
              const storeAbbr = store.abbreviation.slice(0, 2).toUpperCase();
              const trackingNum = parseInt(delivery.tracking_number) || 0;
              const formattedNum = trackingNum > 99 ? trackingNum.toString().padStart(3, "0") : trackingNum.toString().padStart(2, "0");
              return `${storeAbbr}${formattedNum}`;
            })()}
          </Badge>
        )}
      </div>
    </>
  );
}