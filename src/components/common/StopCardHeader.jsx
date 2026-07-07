import React, { useEffect, useMemo, useState, useRef } from "react";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import SpecialSymbolsBadges from "../utils/SpecialSymbolsBadges";
import { getDriverDisplayName } from "../utils/driverUtils";
import { calculateDeliveryPay, formatPay } from "../utils/payCalculator";
import { userHasRole } from "../utils/userRoles";
import { useAppData } from "../utils/AppDataContext";
import { format } from "date-fns";
import { getCurrentEtaForDelivery, getEtaTrendForDelivery, primeEtaTrendBus } from "../utils/etaTrendBus";
import { Thermometer } from "lucide-react";
import { computeFridgeAvgTemp } from "../utils/fridgeTempAverage";
import { offlineDB } from "../utils/offlineDatabase";

const TEMP_MIN = 2;
const TEMP_MAX = 6;

function getLatestTempReading(delivery) {
  if (!Array.isArray(delivery?.temperature_readings) || delivery.temperature_readings.length === 0) return null;
  return delivery.temperature_readings.reduce((latest, r) =>
    !latest || r.timestamp > latest.timestamp ? r : latest, null
  );
}

// Shared live temp from the same source as LiveTempBadge (window events)
function useLiveTempReading(driverId) {
  const [liveReading, setLiveReading] = useState(null);

  useEffect(() => {
    if (!driverId) return;

    const handleRecorded = (e) => {
      const { temperature, timestamp, driverId: eventDriverId } = e.detail || {};
      if (eventDriverId !== driverId) return;
      setLiveReading({ temperature_celsius: temperature, timestamp });
    };

    const handleWsUpdate = (e) => {
      const { data } = e.detail || {};
      if (!data || data.driver_id !== driverId) return;
      const latest = data.latest_reading || null;
      if (latest) setLiveReading(latest);
    };

    window.addEventListener('fridgeTempRecorded', handleRecorded);
    window.addEventListener('rxTempLogsUpdated', handleWsUpdate);
    return () => {
      window.removeEventListener('fridgeTempRecorded', handleRecorded);
      window.removeEventListener('rxTempLogsUpdated', handleWsUpdate);
    };
  }, [driverId]);

  return liveReading;
}

// Fetches flat temperature readings for a driver+date from offline DB, kept live via WS events
function useDriverTempReadings(driverId, deliveryDate) {
  const [readings, setReadings] = useState([]);

  useEffect(() => {
    if (!driverId || !deliveryDate) return;
    let cancelled = false;
    offlineDB.getByCompoundIndex(offlineDB.STORES.RX_TEMP_LOGS, 'date_driver', [deliveryDate, driverId])
      .then((logs) => {
        if (cancelled) return;
        const flat = (logs || []).flatMap((l) => l.temperature_readings || []).filter((r) => r?.timestamp != null && r.temperature_celsius != null);
        setReadings(flat);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [driverId, deliveryDate]);

  useEffect(() => {
    if (!driverId || !deliveryDate) return;
    const handleWsUpdate = (e) => {
      const { data } = e.detail || {};
      if (!data || data.driver_id !== driverId || data.delivery_date !== deliveryDate) return;
      const flat = (data.temperature_readings || []).filter((r) => r?.timestamp != null && r.temperature_celsius != null);
      if (flat.length) setReadings(flat);
    };
    // Also handle individual reading events — only if the reading date matches the delivery date
    const handleRecorded = (e) => {
      const { temperature, timestamp, driverId: eid } = e.detail || {};
      if (eid !== driverId || !temperature || !timestamp) return;
      // Guard: only add readings whose date matches the delivery date we're tracking
      const readingDate = String(timestamp).slice(0, 10);
      if (readingDate !== deliveryDate) return;
      setReadings((prev) => [...prev, { temperature_celsius: temperature, timestamp }]);
    };
    window.addEventListener('rxTempLogsUpdated', handleWsUpdate);
    window.addEventListener('fridgeTempRecorded', handleRecorded);
    return () => {
      window.removeEventListener('rxTempLogsUpdated', handleWsUpdate);
      window.removeEventListener('fridgeTempRecorded', handleRecorded);
    };
  }, [driverId, deliveryDate]);

  return readings;
}

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
  returned: { label: "Return" }
};

function extractStoredTime(value) {
  if (!value) return null;
  const raw = String(value);
  const hasTimezoneSuffix = /Z$|[+-]\d{2}:?\d{2}$/.test(raw);
  if (hasTimezoneSuffix) {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) {
      return `${String(parsed.getHours()).padStart(2, '0')}:${String(parsed.getMinutes()).padStart(2, '0')}`;
    }
  }
  const isoMatch = raw.match(/T(\d{2}:\d{2})/);
  if (isoMatch) return isoMatch[1];
  const timeMatch = raw.match(/^(\d{2}:\d{2})/);
  if (timeMatch) return timeMatch[1];
  return null;
}

function formatTime24Hour(timeString) {
  if (!timeString || ["--:--", "null", "undefined", "NaN:NaN"].includes(String(timeString))) return "--:--";
  try {
    const normalized = extractStoredTime(timeString) || String(timeString);
    const [h, m] = normalized.split(":");
    const hours = parseInt(h, 10);
    const minutes = parseInt(m, 10);
    if (isNaN(hours) || isNaN(minutes)) return "--:--";
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
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
  bulkSelectionEnabled = false,
  onSelectionChange,
  isSelected = false,
  selectedDeliveryIds = {},
  ispSourceStore = null,
  allDeliveries = [],
}) {
  const { appUsers: contextAppUsers } = useAppData();
  const resolvedAppUsers = appUsers?.length ? appUsers : (contextAppUsers || []);

  const liveTemp = useLiveTempReading(delivery?.driver_id);
  const tempReadings = useDriverTempReadings(delivery?.driver_id, delivery?.delivery_date);
  const [, setEtaTrendVersion] = React.useState(0);
  React.useEffect(() => {
    primeEtaTrendBus([delivery]);
    const handler = () => setEtaTrendVersion((value) => value + 1);
    window.addEventListener('etaTrendUpdated', handler);
    window.addEventListener('deliveriesUpdated', handler);
    return () => {
      window.removeEventListener('etaTrendUpdated', handler);
      window.removeEventListener('deliveriesUpdated', handler);
    };
  }, [delivery]);

  const isFinished = FINISHED_STATUSES.includes(delivery?.status);
  const etaTrend = !isFinished ? getEtaTrendForDelivery(delivery?.id) : null;
  const timeColor = etaTrend?.trend === 'improved' ?
  '#16a34a' :
  etaTrend?.trend === 'delayed' ?
  '#dc2626' :
  'var(--text-slate-600)';

  const timeDisplay = (() => {
    if (isFinished) {
      const actual = formatTime24Hour(delivery?.actual_delivery_time);
      const arrival = formatTime24Hour(delivery?.arrival_time);
      const hasActual = actual !== "--:--";
      const hasArrival = arrival !== "--:--";

      if (hasArrival || hasActual) {
        return <span className="text-sm font-bold">{hasArrival && hasActual ? `${arrival} → ${actual}` : hasArrival ? arrival : actual}</span>;
      }

      return <span className="text-sm font-bold">--:--</span>;
    }
    const eta = getCurrentEtaForDelivery(
      delivery?.id,
      delivery?.delivery_time_eta || (isPickup ? delivery?.delivery_time_start : null) || delivery?.delivery_time_start || "--:--"
    );
    return <span className="text-sm font-bold">ETA: {formatTime24Hour(eta)}</span>;
  })();

  const statusLabel = isReturnDelivery
    ? 'Return'
    : statusConfig[delivery?.status]?.label || delivery?.status;
  const statusBgClass = isReturnDelivery
    ? "bg-orange-500"
    : delivery?.status === "failed" || delivery?.status === "cancelled"
      ? "bg-red-500"
      : delivery?.status === "in_transit"
        ? "bg-blue-500"
        : delivery?.status === "en_route"
          ? "bg-cyan-500"
          : delivery?.status === "pending"
            ? "bg-slate-500"
            : "bg-emerald-500";

  // Driver pay (for finished stops shown to drivers/admins)

  const isInterStore = !delivery?.patient_id && (String(delivery?.delivery_id || '').toUpperCase().startsWith('ISP-') || String(delivery?.delivery_id || '').toUpperCase().startsWith('ISD-'));
  const isPickupStop = !delivery?.patient_id;
  // Store pickups (no patient_id, not ISD/ISP) only show pay if after_hours_pickup is true
  const isStorePickup = !delivery?.patient_id && !isInterStore;
  
  const isAdmin = userHasRole(currentUser, "admin");
  const isDriver = userHasRole(currentUser, "driver");

  const showDriverPay = isFinished && (isDriver || isAdmin) && !!(delivery?.patient_id || isInterStore || (isStorePickup && delivery?.after_hours_pickup));
  const driverAppUser = React.useMemo(() => {
    if (!delivery?.driver_id) return null;

    return (resolvedAppUsers).find((au) => au?.user_id === delivery.driver_id || au?.id === delivery.driver_id) ||
          ((safeDriver?.user_id === delivery?.driver_id || safeDriver?.id === delivery?.driver_id) ? safeDriver : null);
  }, [resolvedAppUsers, delivery?.driver_id, safeDriver]);


  const payBadge = React.useMemo(() => {
    if (!showDriverPay || !driverAppUser) return null;

    const pay = calculateDeliveryPay(delivery, driverAppUser, patient);
    const baseRate = driverAppUser?.pay_rate_per_delivery || 0;
    const isAfterHours = delivery?.after_hours_pickup === true;
    const hasExtraPay = pay > baseRate && !isAfterHours;
    const isNoCharge = delivery?.no_charge === true;
    const payDisplay = isNoCharge ? 'N/C' : formatPay(pay);

    return !isAfterHours && !hasExtraPay ?
      <div className="text-emerald-600 pt-1 text-xs font-bold">{payDisplay}</div> :
      <Badge variant="secondary" className="inline-flex items-center border transition-colors text-xm font-bold px-2 py-0.5 rounded-full bg-green-200 !text-gray-800">
        {payDisplay}
      </Badge>;
  }, [showDriverPay, driverAppUser, delivery, patient]);

  return (
    <>
      {/* Left badges column */}
      <div className="mt-0 mb-1 my-0.5 py-0.5 flex flex-col items-center gap-1.0 min-w-[50px]">
        <Badge
          variant="secondary"
          className={`bg-secondary text-white mt-1 px-2 py-0.5 text-sm font-bold ${delivery?.ampm_deliveries === 'PM' ? 'rounded-md' : 'rounded-full'} inline-flex items-center border transition-colors justify-center ${bulkSelectionEnabled ? 'gap-1 min-w-[58px]' : 'w-[40px]'}`}
          style={{ backgroundColor: storeColor || "#10B981", color: "white" }}>
          {bulkSelectionEnabled && (
            <div
              data-stopcard-checkbox="true"
              className="-m-1 flex h-7 w-7 items-center justify-center rounded-full"
              onClick={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
              onTouchStart={(event) => event.stopPropagation()}
            >
              <Checkbox
                checked={!!selectedDeliveryIds[delivery?.id]}
                onClick={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
                onTouchStart={(event) => event.stopPropagation()}
                onCheckedChange={(checked) => onSelectionChange?.(delivery.id, !!checked)}
                aria-label="Select stop"
                className="h-5 w-5 border-white bg-white/90 data-[state=checked]:bg-white data-[state=checked]:text-slate-900"
              />
            </div>
          )}
          <span className="pointer-events-none">#{delivery?.display_stop_order || delivery?.stop_order || 0}</span>
        </Badge>

        {isPickup && pendingPickups && pendingPickups.length > 0 &&
        <Badge
          variant="secondary"
          className="bg-purple-500 text-secondary-foreground mt-1 px-2 text-sm font-bold rounded-lg inline-flex items-center border !text-white justify-center">

            P: {pendingPickups.length}
          </Badge>
        }

        <div className="flex items-center gap-0.5 flex-wrap justify-center">
          <SpecialSymbolsBadges
            delivery={delivery}
            patient={patient}
            isPickup={isPickup}
            isInterStore={isInterStore}
            size="card"
            className="mt-1"
            fridgeTemp={delivery?.fridge_item ? (() => {
              const isFinished = FINISHED_STATUSES.includes(delivery?.status);
              // Average over the precise fridge-carry window (uses delivery's own date readings)
              if (tempReadings.length > 0) {
                const avg = computeFridgeAvgTemp(delivery, allDeliveries, tempReadings);
                if (avg != null) return avg;
              }
              // Active stop on today's date: fall back to live BLE/WS reading
              const today = new Date().toISOString().slice(0, 10);
              const isToday = delivery?.delivery_date === today;
              if (!isFinished && isToday) {
                return liveTemp?.temperature_celsius ?? getLatestTempReading(delivery)?.temperature_celsius ?? null;
              }
              return null;
            })() : null}
          />

          {/* Fridge temperature badge - uses same source as LiveTempBadge above stop cards */}
          {delivery?.fridge_item && !isPickup && (() => {
            const deliveryTemp = getLatestTempReading(delivery);
            const today = new Date().toISOString().slice(0, 10);
            const isToday = delivery?.delivery_date === today;
            // Only use live temp for today's deliveries; past dates use stored readings only
            const reading = (isToday ? liveTemp : null) || deliveryTemp;
            if (!reading) return (
              <Badge className="mt-1 text-[11px] px-1.5 py-0 h-6 rounded-full bg-cyan-100 text-cyan-700 border border-cyan-300 font-bold inline-flex items-center gap-0.5">
                <Thermometer className="w-2.5 h-3" />--°C
              </Badge>
            );
            const isOut = reading.temperature_celsius < TEMP_MIN || reading.temperature_celsius > TEMP_MAX;
            return (
              <Badge className={`mt-1 text-[10px] px-1.5 py-0 h-6 rounded-full font-bold inline-flex items-center gap-0.5 ${isOut ? 'bg-red-100 text-red-700 border border-red-300' : 'bg-cyan-100 text-cyan-700 border border-cyan-300'}`}>
                <Thermometer className="w-2.5 h-3" />{reading.temperature_celsius}°C
              </Badge>
            );
          })()}
        </div>

      </div>

      {/* Center section */}
      <div className="flex-1 min-w-0">
        <h3 className="pt-0 text-xl font-semibold text-center truncate" style={{ color: "var(--text-slate-900)" }}>
          {finalDisplayName}
        </h3>
        <div className="flex flex-col items-center min-h-[43px]">
          <div className="text-lg flex items-center justify-center gap-2" style={{ color: timeColor }}>
            {timeDisplay}
            {showDriverName && userHasRole(currentUser, 'dispatcher') && safeDriver && (
              <Badge
                variant="secondary"
                className="px-2 py-0.5 text-xs font-bold rounded-full inline-flex items-center border transition-colors justify-center !text-white"
                style={{ backgroundColor: driverBadgeColor }}>
                {getDriverDisplayName(safeDriver)}
              </Badge>
            )}
          </div>

          {/* Time window for active stops — ISP/ISD only shows start time, no end */}
          {!isFinished && (delivery?.delivery_time_start || delivery?.delivery_time_end) &&
          <div className="text-xs font-bold" style={{ color: "var(--text-slate-500)" }}>
              {isInterStore ? (
                delivery?.delivery_time_start ? <>{formatTime24Hour(delivery.delivery_time_start)} →</> : null
              ) : delivery?.delivery_time_start && delivery?.delivery_time_end ?
            <>
                  {formatTime24Hour(delivery.delivery_time_start)} → {formatTime24Hour(delivery.delivery_time_end)}
                </> :
            delivery?.delivery_time_start ?
            <>{formatTime24Hour(delivery.delivery_time_start)} →</> :
            delivery?.delivery_time_end ?
            <>← {formatTime24Hour(delivery.delivery_time_end)}</> :
            null}
            </div>
          }

          {showDriverPay && payBadge}
        </div>
      </div>

      {/* Right column */}
      <div className="my-0.5 mt-0 mb-1 py-0.5 flex flex-col items-center gap-1.0 min-w-[80px]">
        <div className="flex items-center gap-1">
          <Badge
            variant="secondary"
            data-stop-status={isReturnDelivery ? "returned" : delivery?.status || "unknown"}
            data-stop-kind={isPickup ? "pickup" : "delivery"}
            className={`text-secondary-foreground mt-1 px-2 text-sm font-bold rounded-full ${statusBgClass}`}
            style={{ color: isPickup && delivery?.after_hours_pickup && isFinished ? "#3b82f6" : "white" }}>

            {statusLabel}
          </Badge>
        </div>

        {delivery?.tracking_number && (ispSourceStore?.abbreviation || store?.abbreviation) &&
        <Badge
          variant="secondary"
          className="bg-secondary text-secondary-foreground mt-1 px-2 py-0.5 text-sm font-bold rounded-full inline-flex items-center"
          style={{ backgroundColor: `${storeColor}`, color: `White` }}>

            {(() => {
            // For ISP deliveries use the originating source store abbreviation
            const effectiveStore = ispSourceStore || store;
            const storeAbbr = effectiveStore.abbreviation.slice(0, 2).toUpperCase();
            const trackingNum = parseInt(delivery.tracking_number) || 0;
            const formattedNum = trackingNum > 99 ? trackingNum.toString().padStart(3, "0") : trackingNum.toString().padStart(2, "0");
            return `${storeAbbr}${formattedNum}`;
          })()}
          </Badge>
        }
      </div>
    </>);

}