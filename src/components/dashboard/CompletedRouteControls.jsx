import React from 'react';
import { format } from 'date-fns';
import { isAppOwner } from '@/components/utils/userRoles';
import { base44 } from '@/api/base44Client';
import { offlineDB } from '@/components/utils/offlineDatabase';
import ResetPolylinesButton from '@/components/dashboard/ResetPolylinesButton';

// Decode Google-encoded polyline into [[lat, lng], ...]
const decodePolyline = (encoded) => {
  if (!encoded || typeof encoded !== 'string') return [];
  let index = 0, lat = 0, lng = 0;
  const coords = [];
  while (index < encoded.length) {
    let shift = 0, result = 0, byte;
    do { byte = encoded.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do { byte = encoded.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    coords.push([lat / 1e5, lng / 1e5]);
  }
  return coords;
};

async function fetchBreadcrumbsForDriver(driverId, dateStr) {
  // Try API first
  try {
    const records = await base44.entities.DeliveryBreadcrumbs.filter(
      { driver_id: driverId, delivery_date: dateStr }
    );
    if (Array.isArray(records) && records.length > 0) {
      return records.filter(r => r?.encoded_polyline);
    }
  } catch (_) {}

  // Fall back to offline DB
  try {
    const offline = await offlineDB.getByCompoundIndex(
      offlineDB.STORES.DELIVERY_BREADCRUMBS,
      'date_driver',
      [dateStr, driverId]
    );
    return (offline || []).filter(r => r?.encoded_polyline);
  } catch (_) {}

  return [];
}

export default function CompletedRouteControls({
  currentUser,
  isMobile,
  selectedDriverId,
  selectedDate,
  isRouteComplete,
  showRoutes,
  setShowRoutes,
  showBreadcrumbs,
  setShowBreadcrumbs,
  setBreadcrumbsData,
  deliveriesWithStopOrder,
}) {
  if (isMobile) return null;
  if (!isAppOwner(currentUser)) return null;
  if (!selectedDriverId || selectedDriverId === 'all') return null;
  if (!isRouteComplete) return null;

  return (
    <div className="absolute top-3 right-3 z-[480] pointer-events-auto">
      <div
        className="rounded-lg border shadow-md overflow-hidden"
        style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}
      >
        <div className="flex items-stretch">
          <div className="px-3 py-2 flex flex-col gap-2 min-w-[148px]">
            <label
              className="flex items-center gap-2 text-sm cursor-pointer select-none"
              style={{ color: 'var(--text-slate-900)' }}
              onClick={() => {
                setShowRoutes(true);
                setShowBreadcrumbs(false);
                setBreadcrumbsData({ historical: [], current: [] });
                localStorage.setItem('rxdeliver_show_routes', 'true');
              }}
            >
              <span className={`h-4 w-4 min-h-4 min-w-4 rounded-full border flex items-center justify-center flex-shrink-0 ${showRoutes ? 'border-amber-600' : 'border-slate-400'}`}>
                {showRoutes && <span className="h-2 w-2 rounded-full bg-amber-600" />}
              </span>
              <span>Show Polylines</span>
            </label>

            <label
              className="flex items-center gap-2 text-sm cursor-pointer select-none"
              style={{ color: 'var(--text-slate-900)' }}
              onClick={async () => {
                const selectedDateStr = format(selectedDate, 'yyyy-MM-dd');
                const records = await fetchBreadcrumbsForDriver(selectedDriverId, selectedDateStr);
                if (records.length === 0) {
                  setShowBreadcrumbs(false);
                  setBreadcrumbsData({ historical: [], current: [] });
                  return;
                }
                setBreadcrumbsData({ historical: records, current: [] });
                setShowBreadcrumbs(true);
                setShowRoutes(false);
                localStorage.setItem('rxdeliver_show_routes', 'false');
              }}
            >
              <span className={`h-4 w-4 min-h-4 min-w-4 rounded-full border flex items-center justify-center flex-shrink-0 ${showBreadcrumbs ? 'border-amber-600' : 'border-slate-400'}`}>
                {showBreadcrumbs && <span className="h-2 w-2 rounded-full bg-amber-600" />}
              </span>
              <span>Show Breadcrumbs</span>
            </label>
          </div>

          <div className="border-l flex items-start justify-center p-2" style={{ borderColor: 'var(--border-slate-200)' }}>
            <ResetPolylinesButton
              selectedDriverIds={[selectedDriverId]}
              selectedDate={format(selectedDate, 'yyyy-MM-dd')}
              selectedPolylineOption={showBreadcrumbs ? 'breadcrumbs' : 'polylines'}
              mode="inline"
              disabled={!deliveriesWithStopOrder?.length}
              className="h-8 w-8 p-0"
              forceDrivingMode={true}
            />
          </div>
        </div>
      </div>
    </div>
  );
}