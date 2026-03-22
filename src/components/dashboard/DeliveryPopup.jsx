import React from 'react';
import SpecialSymbolsBadges from '../utils/SpecialSymbolsBadges';
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
        onPatientClick={!isPickup ? () => {
          const destination = `${patient?.address || ''}${patient?.unit_number ? ' #' + patient.unit_number : ''}`;
          const url = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}`;
          window.open(url, '_blank');
        } : undefined}
        extraContent={(
          <div className="space-y-1.5">
            <p className="text-xs" style={{ color: 'var(--text-slate-600)' }}>
              {isPickup ? store?.address : patient?.address}
              {!isPickup && patient?.unit_number && <span className="ml-1">#{patient.unit_number}</span>}
            </p>

            {delivery.prescription_number && (
              <div className="text-xs" style={{ color: 'var(--text-slate-600)' }}>
                <span className="font-medium">Rx#</span> {delivery.prescription_number}
              </div>
            )}

            {delivery.cod_total_amount_required > 0 && (
              <div className="flex items-center gap-1 text-xs font-semibold px-2 py-1 rounded" style={{ color: '#059669', background: 'rgba(5, 150, 105, 0.1)' }}>
                {(() => {
                  const hasCODPayments = delivery.cod_payments &&
                    Array.isArray(delivery.cod_payments) &&
                    delivery.cod_payments.length > 0 &&
                    delivery.cod_payments.some((p) => p?.amount > 0);

                  if (hasCODPayments) {
                    const primaryPayment = delivery.cod_payments.find((p) => p?.amount > 0);
                    if (primaryPayment) {
                      return <span>💵 {primaryPayment.type}: ${primaryPayment.amount.toFixed(2)}</span>;
                    }
                  }

                  return <span>💵 COD: ${delivery.cod_total_amount_required.toFixed(2)}</span>;
                })()}
              </div>
            )}

            {!isPickup && delivery.delivery_instructions && (
              <div className="text-xs italic" style={{ color: 'var(--text-slate-500)' }}>
                {delivery.delivery_instructions}
              </div>
            )}

            {delivery.delivery_notes && (
              <div className="text-xs text-blue-600">
                <span className="font-medium">Notes:</span> {delivery.delivery_notes}
              </div>
            )}

            {!isPickup && (
              <div className="border-t pt-1.5 mt-1.5" style={{ borderColor: 'var(--border-slate-200)' }}>
                <SpecialSymbolsBadges delivery={delivery} patient={patient} size="sm" />
              </div>
            )}
          </div>
        )}
      />
    </div>
  );
}