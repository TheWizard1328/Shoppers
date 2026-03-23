import { Clock } from 'lucide-react';
import { format } from 'date-fns';

const extractStoredTime = (value) => {
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
};

const formatTime12Hour = (timeString) => {
  if (!timeString ||
    timeString === '--:--' ||
    timeString === 'null' ||
    timeString === 'undefined' ||
    timeString === 'NaN:NaN' ||
    String(timeString).includes('NaN')) {
    return '--:--';
  }

  try {
    const normalized = extractStoredTime(timeString) || String(timeString);
    const timeParts = normalized.split(':');
    if (timeParts.length < 2) return '--:--';

    const hours = parseInt(timeParts[0], 10);
    const minutes = parseInt(timeParts[1], 10);

    if (isNaN(hours) || isNaN(minutes)) {
      return '--:--';
    }

    const period = hours >= 12 ? 'PM' : 'AM';
    const displayHours = hours % 12 || 12;
    return `${displayHours}:${String(minutes).padStart(2, '0')} ${period}`;
  } catch (error) {
    return '--:--';
  }
};

export default function StopCardTimingDisplay({ 
  delivery, 
  isPickup, 
  FINISHED_STATUSES 
}) {
  return (
    <>
      {/* ETA - show for non-finished stops when available */}
      {!FINISHED_STATUSES.includes(delivery?.status) && delivery?.delivery_time_eta && (
        <div className="text-sm md:text-[11px] flex items-center gap-1" style={{ color: 'var(--text-blue-600)' }}>
          <Clock className="w-3 h-3" />
          ETA: {formatTime12Hour(delivery.delivery_time_eta)}
        </div>
      )}
      {/* ETA - show for non-finished stops when available */}
      {!FINISHED_STATUSES.includes(delivery?.status) && delivery?.delivery_time_eta && (
        <div className="text-sm md:text-[11px] flex items-center gap-1" style={{ color: 'var(--text-blue-600)' }}>
          <Clock className="w-3 h-3" />
          ETA: {formatTime12Hour(delivery.delivery_time_eta)}
        </div>
      )}
      {/* Time Window - Only for non-finished stops */}
      {!FINISHED_STATUSES.includes(delivery?.status) && (delivery?.delivery_time_start || delivery?.delivery_time_end) &&
        <div className="text-sm md:text-[11px]" style={{ color: 'var(--text-slate-500)' }}>
          {delivery?.delivery_time_start && delivery?.delivery_time_end ?
            <>{formatTime12Hour(delivery.delivery_time_start)} → {formatTime12Hour(delivery.delivery_time_end)}</> :
            delivery?.delivery_time_start ?
              <>{formatTime12Hour(delivery.delivery_time_start)} →</> :
              delivery?.delivery_time_end ?
                <>← {formatTime12Hour(delivery.delivery_time_end)}</> :
                null}
        </div>
      }
      {/* Arrival and Completion Times for Pickups */}
      {isPickup && (delivery?.arrival_time || delivery?.actual_delivery_time) &&
        <div className="text-sm md:text-[11px] flex items-center gap-1" style={{ color: 'var(--text-slate-500)' }}>
          {delivery?.arrival_time && (
            <span className="flex items-center gap-1">
              <Clock className="w-3 h-3" />
              Arr: {formatTime12Hour(delivery.arrival_time)}
            </span>
          )}
          {delivery?.arrival_time && delivery?.actual_delivery_time && <span>•</span>}
          {delivery?.actual_delivery_time && (
            <span>Done: {formatTime12Hour(delivery.actual_delivery_time)}</span>
          )}
        </div>
      }
    </>
  );
}