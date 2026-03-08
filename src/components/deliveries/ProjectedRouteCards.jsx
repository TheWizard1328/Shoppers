import React from 'react';
import { formatPhoneNumber } from '../utils/phoneFormatter';

export function ProjectedDeliveryList({ deliveries, stopOrderMap }) {
  return (
    <div className="mt-3">
      <div className="max-h-48 overflow-y-auto border rounded-lg">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-slate-100/80 backdrop-blur-sm z-10">
            <tr>
              <th className="text-left font-medium p-2 w-10">#</th>
              <th className="text-left font-medium p-2">TR#</th>
              <th className="text-left font-medium p-2">Patient</th>
              <th className="text-right font-medium p-2">Dist</th>
            </tr>
          </thead>
          <tbody className="bg-white">
            {deliveries.map((d) => {
              const stopNumber = stopOrderMap[d.id];
              const trackingNumber = d.tracking_number || '';
              const storeAbbr = trackingNumber.substring(0, 2);
              return (
                <tr key={d.id} className="border-b border-slate-100 last:border-b-0">
                  <td className="p-2 font-medium">{stopNumber}</td>
                  <td className="p-2 font-mono">{trackingNumber.replace(storeAbbr, '')}</td>
                  <td className="p-2 truncate">{d.patient_name}</td>
                  <td className="p-2 truncate text-right">{(d.distance_from_store ?? 0).toFixed(1)}km</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function ProjectedPickupCard({ pickup, stopOrder, stopOrderMap }) {
  if (!pickup || !pickup.isProjected) return null;
  return (
    <div className="w-80 flex-shrink-0">
      <div className="w-full overflow-hidden shadow-lg border border-slate-200 rounded-lg bg-white">
        <div className="p-4 flex flex-col gap-2">
          <div className="flex items-start gap-3">
            <div className="flex-shrink-0 text-lg font-bold text-white w-8 h-8 flex items-center justify-center rounded-md"
              style={{ backgroundColor: pickup.color || '#71717A' }}>
              {stopOrder}
            </div>
            <div className="flex-grow min-w-0">
              <div className="flex justify-between items-start">
                <h3 className="font-bold text-slate-800 text-sm truncate">{pickup.full_name}</h3>
                <span className="text-[10px] px-2 py-0.5 rounded bg-yellow-100 text-yellow-800 border border-yellow-200">PROJECTED</span>
              </div>
              <div className="text-xs text-slate-600 mt-1 space-y-0.5">
                <p>ETA: {pickup.delivery_time_start}</p>
                <p className="truncate">{pickup.delivery_address}</p>
                {pickup.phone && <p>{formatPhoneNumber(pickup.phone)}</p>}
              </div>
            </div>
            <div className="flex-shrink-0">
              <span className="font-mono text-xs px-2 py-0.5 rounded" style={{ backgroundColor: `${pickup.color || '#71717A'}20`, color: pickup.color || '#71717A' }}>
                {pickup.tracking_number}
              </span>
            </div>
          </div>
          <ProjectedDeliveryList deliveries={pickup.projected_deliveries || []} stopOrderMap={stopOrderMap} />
        </div>
      </div>
    </div>
  );
}