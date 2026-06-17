import { base44 } from '@/api/base44Client';

export function subscribePatientsRealtime({ onPatientChange, onDeliveryChange }) {
  const unsubscribers = [
    base44.entities.Patient.subscribe((event) => {
      onPatientChange?.(event);
    }),
    base44.entities.Delivery.subscribe((event) => {
      onDeliveryChange?.(event);
    })
  ];

  return () => {
    unsubscribers.forEach((unsubscribe) => unsubscribe?.());
  };
}