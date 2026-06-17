import React, { useMemo } from 'react';
import MarkerInfoBalloon from './MarkerInfoBalloon';
import { isInterStoreDelivery, parseInterStoreDeliveryId } from '../utils/interStoreDisplayName';

export default function DeliveryPopup({ delivery, isPickup = false, stores = [], patients = [], users = [], driver: propDriver = null }) {
  const store = stores.find((s) => s && s.id === delivery.store_id);
  const patient = !isPickup ? patients.find((p) => p && (p.id === delivery.patient_id || p.patient_id === delivery.patient_id)) : null;
  const driver = propDriver || users.find((u) => u && u.id === delivery.driver_id);

  // For ISP deliveries, resolve the originating source store by matching pickup phone (parts[2]) against Store.phone
  const isISP = isInterStoreDelivery(delivery?.delivery_id);
  const ispSourceStore = useMemo(() => {
    if (!isISP) return null;
    const parsed = parseInterStoreDeliveryId(delivery?.delivery_id);
    if (parsed?.pickupLocationPhone) {
      const byPhone = stores.find((s) => s?.phone && String(s.phone).replace(/\D/g, '') === parsed.pickupLocationPhone);
      if (byPhone) return byPhone;
    }
    if (delivery?._interstore_source_id) {
      return stores.find((s) => s && s.id === delivery._interstore_source_id) || null;
    }
    return null;
  }, [isISP, delivery?.delivery_id, delivery?._interstore_source_id, stores]);

  return (
    <div className="min-w-[220px] max-w-[320px]" style={{ background: 'var(--bg-white)', color: 'var(--text-slate-900)' }}>
      <MarkerInfoBalloon
        delivery={delivery}
        store={store}
        patient={patient}
        driver={driver}
        isPickup={isPickup}
        ispSourceStore={ispSourceStore}
      />
    </div>
  );
}