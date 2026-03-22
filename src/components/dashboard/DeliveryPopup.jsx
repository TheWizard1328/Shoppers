import React from 'react';
import MarkerInfoBalloon from './MarkerInfoBalloon';

export default function DeliveryPopup({ delivery, isPickup = false, stores = [], patients = [], users = [] }) {
  const store = stores.find((s) => s && s.id === delivery.store_id);
  const patient = !isPickup ? patients.find((p) => p && (p.id === delivery.patient_id || p.patient_id === delivery.patient_id)) : null;
  const driver = users.find((u) => u && u.id === delivery.driver_id);

  return (
    <div className="min-w-[220px] max-w-[320px]" style={{ background: 'var(--bg-white)', color: 'var(--text-slate-900)' }}>
      <MarkerInfoBalloon
        delivery={delivery}
        store={store}
        patient={patient}
        driver={driver}
        isPickup={isPickup}
      />
    </div>
  );
}