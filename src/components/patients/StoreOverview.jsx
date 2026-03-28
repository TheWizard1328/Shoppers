import React, { useMemo, useCallback } from 'react';
import { format } from 'date-fns';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { hexToRgba } from '@/components/utils/colorGenerator';
import { formatPhoneNumber } from '@/components/utils/phoneFormatter';

export default function StoreOverview({ stores, onStoreSelect, allPatients, deliveries, getAssignedDrivers }) {
  const today = useMemo(() => format(new Date(), 'yyyy-MM-dd'), []);

  const getStoreStats = useCallback((store) => {
    const storePatients = allPatients.filter((p) => p.store_id === store.id);
    const storePatientIds = new Set(storePatients.map((p) => p.id));
    const storeDeliveries = deliveries.filter((d) => storePatientIds.has(d.patient_id) && d.delivery_date === today);
    const isReturn = (delivery) => {
      if (!delivery) return false;
      const patient = allPatients.find((p) => p.id === delivery.patient_id);
      return (delivery.delivery_notes || '').toLowerCase().includes('return') || !!(patient && (patient.address || '').toLowerCase().includes('rtn'));
    };
    const returnedDeliveries = storeDeliveries.filter((d) => d.status === 'returned' || isReturn(d));
    const failedDeliveries = storeDeliveries.filter((d) => d.status === 'failed' && !isReturn(d));
    return {
      activeRoutes: storeDeliveries.filter((d) => ['picked_up', 'in_transit', 'pending'].includes(d.status)).length,
      completedRoutes: storeDeliveries.filter((d) => d.status === 'delivered' || d.status === 'completed').length,
      failedRoutes: failedDeliveries.length,
      returnedRoutes: returnedDeliveries.length,
      totalRoutes: storeDeliveries.length
    };
  }, [allPatients, deliveries, today]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="p-6 pb-4 flex-shrink-0">
        <h2 className="text-xl font-semibold" style={{ color: 'var(--text-slate-800)' }}>Select Store to View Patients</h2>
      </div>
      <div className="flex-1 overflow-y-auto px-6 pb-6">
        <div className="card-container" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(275px, 1fr))', gap: '1rem', justifyContent: 'start' }}>
          {stores.map((store) => {
            const stats = getStoreStats(store);
            const driversInfo = getAssignedDrivers(store);
            return (
              <Card key={store.id} className="rounded-xl border shadow cursor-pointer hover:shadow-md transition-all duration-200" style={{ background: 'var(--bg-white)', color: 'var(--text-slate-900)', borderColor: store.color || 'var(--border-slate-200)', borderWidth: '2px' }} onClick={() => onStoreSelect(store.id)}>
                <CardContent className="p-4">
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="font-semibold text-base" style={{ color: 'var(--text-slate-900)' }}>{store.name}</h3>
                        {store.abbreviation && <Badge variant="outline" className="text-foreground px-2.5 py-0.5 text-xs font-semibold opacity-75 rounded-[10px] inline-flex items-center border transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2" style={{ backgroundColor: 'transparent', backgroundImage: store.color ? `linear-gradient(to bottom right, ${store.color}, ${hexToRgba(store.color, 0.8)})` : 'linear-gradient(to bottom right, #10B981, #059669)', color: store.color ? 'white' : '#475569', borderColor: store.color || '#e2e8f0' }}>{store.abbreviation}</Badge>}
                      </div>
                      <p className="text-sm" style={{ color: 'var(--text-slate-600)' }}>{store.address}</p>
                      <p className="text-sm font-medium" style={{ color: 'var(--text-slate-600)' }}>{store.phone ? formatPhoneNumber(store.phone) : ''}</p>
                    </div>
                    <div className="text-center ml-3">
                      <div className="text-3xl font-bold text-emerald-600 mb-1">{store.patientCount || 0}</div>
                      <div className="text-xs mb-1" style={{ color: 'var(--text-slate-500)' }}>patients</div>
                    </div>
                  </div>
                  <div className="pt-2 mt-2" style={{ borderTop: '1px solid var(--border-slate-100)' }}>
                    {stats.totalRoutes > 0 && <div className="flex justify-center gap-3 text-xs font-medium flex-wrap"><span className="text-blue-600">Active: {stats.activeRoutes}</span><span className="text-green-600">Comp: {stats.completedRoutes}</span><span className="text-red-600">Failed: {stats.failedRoutes}</span><span className="text-orange-600">Returns: {stats.returnedRoutes}</span></div>}
                    <div className="text-sm" style={{ color: 'var(--text-slate-600)' }}>
                      <div className="font-semibold mb-1" style={{ color: 'var(--text-slate-700)' }}>Assigned Drivers:</div>
                      <table className="w-full text-xs table-fixed">
                        <thead><tr style={{ borderBottom: '1px solid var(--border-slate-200)' }}><th className="w-1/3 text-left py-1 pr-2 font-medium" style={{ color: 'var(--text-slate-600)' }}>Day</th><th className="w-1/3 text-center py-1 px-2 font-medium" style={{ color: 'var(--text-slate-600)' }}>AM</th><th className="w-1/3 text-center py-1 pl-2 font-medium" style={{ color: 'var(--text-slate-600)' }}>PM</th></tr></thead>
                        <tbody>
                          {[{ day: 'Mon-Fri', am: driversInfo.weekdayAM, pm: driversInfo.weekdayPM }, { day: 'Saturday', am: driversInfo.saturdayAM, pm: driversInfo.saturdayPM }, { day: 'Sunday', am: driversInfo.sundayAM, pm: driversInfo.sundayPM }].map(({ day, am, pm }) => (
                            <tr key={day}>
                              <td className="w-1/3 text-left py-1 pr-2" style={{ color: 'var(--text-slate-700)' }}>{day}</td>
                              <td className="w-1/3 text-center py-1 px-2">{am !== 'Off' ? <Badge variant="outline" className="text-foreground px-2.5 py-0.5 text-xs font-semibold opacity-75 rounded-[10px] inline-flex items-center border transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2" style={{ backgroundColor: 'transparent', backgroundImage: store.color ? `linear-gradient(to bottom right, ${store.color}, ${hexToRgba(store.color, 0.8)})` : 'linear-gradient(to bottom right, #10B981, #059669)', color: store.color ? 'white' : '#475569', borderColor: store.color || '#e2e8f0', width: '80px', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>{am}</Badge> : 'Off'}</td>
                              <td className="w-1/3 text-center py-1 pl-2">{pm !== 'Off' ? <Badge variant="outline" className="text-foreground px-2.5 py-0.5 text-xs font-semibold opacity-75 rounded-[10px] inline-flex items-center border transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2" style={{ backgroundColor: 'transparent', backgroundImage: store.color ? `linear-gradient(to bottom right, ${store.color}, ${hexToRgba(store.color, 0.8)})` : 'linear-gradient(to bottom right, #10B981, #059669)', color: store.color ? 'white' : '#475569', borderColor: store.color || '#e2e8f0', width: '80px', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>{pm}</Badge> : 'Off'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
        {stores.length === 0 && <Card className="mt-4" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}><CardContent className="p-6 text-center" style={{ color: 'var(--text-slate-500)' }}>No stores found for this city.</CardContent></Card>}
      </div>
    </div>
  );
}