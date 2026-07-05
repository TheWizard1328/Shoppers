import React, { useState } from 'react';
import { HeartPulse, LogOut, Package, ChevronDown, ChevronUp } from 'lucide-react';
import PatientDeliveryCard from './PatientDeliveryCard';
import { PatientSessionManager } from './PatientSessionManager';

export default function PatientSidebar({ patient, deliveries, pickupStops, stores, isOpen, onClose }) {
  const [showAll, setShowAll] = useState(false);

  const storeMap = {};
  (stores || []).forEach((s) => { storeMap[s.id] = s.name; });

  // Sort deliveries newest first
  const sorted = [...(deliveries || [])].sort((a, b) =>
    (b.delivery_date || '').localeCompare(a.delivery_date || '')
  );

  const displayed = showAll ? sorted : sorted.slice(0, 10);

  const handleLogout = () => {
    if (window.confirm('Are you sure you want to sign out?')) {
      PatientSessionManager.logout();
    }
  };

  return (
    <>
      {/* Overlay on mobile */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/40 z-[999] md:hidden"
          onClick={onClose}
        />
      )}

      <div
        className={`fixed top-0 left-0 h-full w-72 bg-slate-50 border-r border-slate-200 flex flex-col z-[1000] transform transition-transform duration-300 ${
          isOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'
        }`}
      >
        {/* Header */}
        <div className="p-4 border-b border-slate-200 bg-white flex-shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-slate-900 flex items-center justify-center flex-shrink-0">
              <HeartPulse className="w-5 h-5 text-white" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs text-slate-400 font-medium">Patient Portal</p>
              <p className="text-sm font-bold text-slate-900 truncate">{patient?.full_name || 'Patient'}</p>
            </div>
          </div>
        </div>

        {/* Delivery History */}
        <div className="flex-1 overflow-y-auto p-3">
          <div className="flex items-center gap-2 px-1 mb-3">
            <Package className="w-4 h-4 text-slate-400" />
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">
              Delivery History
            </p>
            {sorted.length > 0 && (
              <span className="ml-auto text-xs bg-slate-200 text-slate-600 rounded-full px-2 py-0.5 font-medium">
                {sorted.length}
              </span>
            )}
          </div>

          {sorted.length === 0 ? (
            <div className="text-center py-8 px-4">
              <Package className="w-8 h-8 text-slate-300 mx-auto mb-2" />
              <p className="text-sm text-slate-400">No past deliveries yet.</p>
            </div>
          ) : (
            <div className="space-y-2 relative">
              {displayed.map((delivery) => {
                const pickupStop = delivery.puid
                  ? (pickupStops || []).find((d) =>
                      d.puid === delivery.puid &&
                      d.delivery_date === delivery.delivery_date &&
                      d.actual_delivery_time
                    )
                  : null;
                return (
                  <PatientDeliveryCard
                    key={delivery.id}
                    delivery={delivery}
                    storeName={storeMap[delivery.store_id]}
                    pickupTime={pickupStop?.actual_delivery_time || null}
                  />
                );
              })}

              {sorted.length > 10 && (
                <button
                  onClick={() => setShowAll((v) => !v)}
                  className="w-full flex items-center justify-center gap-1.5 text-xs font-medium text-slate-500 hover:text-slate-700 py-2 mt-1"
                >
                  {showAll ? (
                    <><ChevronUp className="w-3.5 h-3.5" /> Show Less</>
                  ) : (
                    <><ChevronDown className="w-3.5 h-3.5" /> Show {sorted.length - 10} More</>
                  )}
                </button>
              )}


            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-3 border-t border-slate-200 bg-white flex-shrink-0">
          <button
            onClick={handleLogout}
            className="w-full flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm text-slate-600 hover:bg-red-50 hover:text-red-600 transition-colors"
          >
            <LogOut className="w-4 h-4" />
            Sign Out
          </button>
        </div>
      </div>
    </>
  );
}