import React, { useMemo } from 'react';
import { Polyline } from 'react-leaflet';

export default function HereType1Polylines({
  mode = 'toNext', // 'toNext' | 'toHome'
  deliveryMarkers = [],
  pickupMarkers = [],
  driverHomeMarkers = [],
  isViewingCurrentDate = false,
  getHereRoute, // async ({lat,lon},{lat,lon}) -> positions [[lat,lng],...]
  cacheRef, // useRef(Map)
  polylineRenderKey,
  setPolylineRenderKey,
}) {
  const polylines = useMemo(() => {
    if (!isViewingCurrentDate || !getHereRoute || !cacheRef) return [];

    const finishedStatuses = new Set(['completed', 'failed', 'cancelled', 'returned']);

    // Group by driver
    const byDriver = new Map();
    [...(deliveryMarkers || []), ...(pickupMarkers || [])].forEach((m) => {
      if (!m?.driver_id) return;
      if (!byDriver.has(m.driver_id)) byDriver.set(m.driver_id, { complete: [], incomplete: [] });
      if (finishedStatuses.has(m.status)) byDriver.get(m.driver_id).complete.push(m);
      else if (m.status !== 'pending') byDriver.get(m.driver_id).incomplete.push(m);
    });

    const elements = [];

    Array.from(byDriver.entries()).forEach(([driverId, buckets]) => {
      // Determine endpoints
      let from = null;
      let to = null;

      if (mode === 'toNext') {
        if (!buckets.incomplete.length) return; // no next
        // next stop: prefer isNextDelivery else first by stop_order
        const next = buckets.incomplete.find((s) => s.isNextDelivery === true) ||
          [...buckets.incomplete].sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0))[0];
        if (!next || typeof next.latitude !== 'number' || typeof next.longitude !== 'number') return;

        // origin: last completed (by actual_delivery_time)
        const lastCompleted = [...buckets.complete]
          .filter((s) => !!s.actual_delivery_time)
          .sort((a, b) => new Date(b.actual_delivery_time) - new Date(a.actual_delivery_time))[0];
        if (!lastCompleted || typeof lastCompleted.latitude !== 'number' || typeof lastCompleted.longitude !== 'number') return;

        from = { lat: lastCompleted.latitude, lon: lastCompleted.longitude };
        to = { lat: next.latitude, lon: next.longitude };
      } else if (mode === 'toHome') {
        // only if route completed (no incomplete but at least one complete)
        if (buckets.incomplete.length > 0 || buckets.complete.length === 0) return;
        const lastCompleted = [...buckets.complete]
          .filter((s) => !!s.actual_delivery_time)
          .sort((a, b) => new Date(b.actual_delivery_time) - new Date(a.actual_delivery_time))[0];
        if (!lastCompleted || typeof lastCompleted.latitude !== 'number' || typeof lastCompleted.longitude !== 'number') return;

        const home = (driverHomeMarkers || []).find((h) => h && h.driverId === driverId);
        if (!home?.latitude || !home?.longitude) return;

        from = { lat: lastCompleted.latitude, lon: lastCompleted.longitude };
        to = { lat: home.latitude, lon: home.longitude };
      }

      if (!from || !to) return;

      // Cache key
      const key = `${mode}-${driverId}-${from.lat.toFixed(5)},${from.lon.toFixed(5)}->${to.lat.toFixed(5)},${to.lon.toFixed(5)}`;
      let positions = cacheRef.current.get(key);

      if (!positions) {
        // Kick off HERE fetch; when returns, store + bump a key to re-render parent
        getHereRoute(from, to).then((pts) => {
          if (pts && pts.length > 1) {
            cacheRef.current.set(key, pts);
            setTimeout(() => {
              try { setPolylineRenderKey((v) => v + 1); } catch {}
            }, 0);
          }
        }).catch(() => {});
        // While loading, display a straight dashed hint as fallback
        positions = [ [from.lat, from.lon], [to.lat, to.lon] ];
      }

      elements.push({ driverId, key, positions });
    });

    return elements;
  }, [isViewingCurrentDate, deliveryMarkers, pickupMarkers, driverHomeMarkers, getHereRoute, cacheRef, setPolylineRenderKey, polylineRenderKey]);

  if (!polylines || polylines.length === 0) return null;

  return (
    <>
      {polylines.map((pl) => (
        <Polyline
          key={`${pl.key}-${polylineRenderKey}`}
          positions={pl.positions}
          pathOptions={{
            color: '#2563eb',
            weight: 4,
            opacity: 0.85,
            dashArray: '4, 8',
            lineJoin: 'round',
            lineCap: 'round'
          }}
          pane="overlayPane"
        />
      ))}
    </>
  );
}