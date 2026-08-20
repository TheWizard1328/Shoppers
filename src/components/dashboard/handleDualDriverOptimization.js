import { base44 } from '@/api/base44Client';
import { populateTemporaryStartTimes } from '@/components/dashboard/DashboardHelpers';
import { optimizeRoute } from '@/components/utils/routeOptimizer';

/**
 * Re-optimize BOTH drivers' remaining stops when a delivery is re-assigned
 * between drivers (dual-driver optimization). Extracted from Dashboard.jsx.
 */
export async function runDualDriverOptimization({
  originalDriverId, newDriverId, deliveryDate,
  drivers, patients, stores, appUsers, deliveriesWithStopOrder, updateDeliveryLocal,
  updateDeliveriesLocally,
}) {
  const fin = ['completed', 'failed', 'cancelled'];
  for (const driverId of [originalDriverId, newDriverId].filter(Boolean)) {
    const driver = drivers.find((d) => d && d.id === driverId);
    if (!driver) continue;
    const driverDeliveries = await base44.entities.Delivery.filter({ delivery_date: deliveryDate, driver_id: driverId }, null, null, null, 'id,driver_id,delivery_date,status,stop_order,isNextDelivery,patient_id,patient_name,store_id,store_name,actual_delivery_time,delivery_time_eta,delivery_time_start,encoded_polyline,travel_dist,puid,delivery_notes,cycling_latitude,cycling_longitude');
    const completed = (driverDeliveries || []).filter((d) => d && fin.includes(d.status));
    const incomplete = (driverDeliveries || []).filter((d) => d && !fin.includes(d.status));
    const sortedCompleted = [...completed].sort((a, b) => { const ta = a.actual_delivery_time ? new Date(a.actual_delivery_time).getTime() : Number.MAX_SAFE_INTEGER; const tb = b.actual_delivery_time ? new Date(b.actual_delivery_time).getTime() : Number.MAX_SAFE_INTEGER; return ta - tb; });
    if (incomplete.length === 0) { for (let i = 0; i < sortedCompleted.length; i++) if (sortedCompleted[i]) await updateDeliveryLocal(sortedCompleted[i].id, { stop_order: i + 1 }); continue; }
    const cyclingMarkersIncomplete = incomplete.filter((d) => d && d.is_cycling_marker);
    const regularIncomplete = incomplete.filter((d) => d && !d.is_cycling_marker);
    const enriched = regularIncomplete.map((d) => { if (!d) return null; const e = { ...d }; if (d.patient_id) { const p = patients.find((x) => x && x.id === d.patient_id); if (p?.latitude) { e.latitude = p.latitude; e.longitude = p.longitude; } } else { const s = stores.find((x) => x && x.id === d.store_id); if (s?.latitude) { e.latitude = s.latitude; e.longitude = s.longitude; } } return e; }).filter((d) => d && d.latitude && d.longitude);
    const optimized = optimizeRoute(populateTemporaryStartTimes(enriched, stores), stores, patients, { useAdvancedOptimization: true, respectManualOrder: false, driverHome: driver.home_latitude ? { lat: driver.home_latitude, lon: driver.home_longitude } : null });
    const incompleteWithCycling = [...optimized, ...cyclingMarkersIncomplete].sort((a, b) => {
      const ao = Number(a.stop_order) || 99999;
      const bo = Number(b.stop_order) || 99999;
      if (a.is_cycling_marker && !a.stop_order) return 1;
      if (b.is_cycling_marker && !b.stop_order) return -1;
      return ao - bo;
    });
    const final = [...sortedCompleted, ...incompleteWithCycling];
    for (let i = 0; i < final.length; i++) { const s = final[i]; if (!s) continue; const upd = { stop_order: i + 1 }; if (!fin.includes(s.status)) { upd.delivery_time_eta = s.estimated_arrival || s.delivery_time_start; upd.delivery_time_start = s.delivery_time_start; upd.delivery_time_end = s.delivery_time_end; upd.ampm_deliveries = s.ampm_deliveries; if (!s.tracking_number || s.tracking_number === '99') upd.tracking_number = s.tracking_number; } await updateDeliveryLocal(s.id, upd); }
  }
}