export const shouldUseImmediateAddToRouteStage = ({ openMode, delivery, stagedDeliveries, formData }) => {
  return openMode === 'add_to_route' && !delivery && (stagedDeliveries?.length || 0) === 0 && !!formData?.patient_id && !!formData?.store_id && !!formData?.delivery_date;
};

export const buildImmediateAddToRouteStage = ({ formData, selectedPatient, stores, allDeliveries }) => {
  const store = (stores || []).find((item) => item && item.id === formData.store_id);
  const stagedStatus = formData?.status === 'in_transit' ? 'in_transit' : 'Staged';
  return {
    ...formData,
    status: stagedStatus,
    _tempId: `temp-${Date.now()}`,
    patient_name: formData.patient_name || selectedPatient?.full_name || '',
    patient_phone: formData.patient_phone || selectedPatient?.phone || '',
    delivery_address: selectedPatient?.address || '',
    unit_number: formData.unit_number || selectedPatient?.unit_number || '',
    store_name: store?.name || '',
    store_abbreviation: store?.abbreviation || '',
    cod_total_amount_required: formData.cod_total_amount_required > 0 ? formData.cod_total_amount_required / 100 : 0,
    first_delivery: !((allDeliveries || []).some((delivery) => delivery && delivery.patient_id === formData.patient_id && delivery.status === 'completed'))
  };
};

export const getAddButtonStatus = ({ formData }) => {
  return formData?.status === 'in_transit' ? 'in_transit' : 'staged';
};