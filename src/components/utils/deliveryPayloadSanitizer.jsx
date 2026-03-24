const DELIVERY_ALLOWED_FIELDS = new Set([
  'company_id',
  'delivery_id',
  'patient_id',
  'dispatcher_id',
  'driver_id',
  'driver_name',
  'created_by_app_user_id',
  'delivery_date',
  'delivery_time_start',
  'delivery_time_end',
  'delivery_time_eta',
  'arrival_time',
  'actual_delivery_time',
  'status',
  'prescription_number',
  'delivery_notes',
  'delivery_instructions',
  'store_id',
  'tracking_number',
  'stop_order',
  'stop_id',
  'puid',
  'extra_time',
  'travel_dist',
  'paid_km_override',
  'cod_total_amount_required',
  'cod_payments',
  'cod_payment_type',
  'cod_amount',
  'signature_needed',
  'signature_image_url',
  'proof_photo_urls',
  'barcode_values',
  'receipt_barcode_values',
  'fridge_item',
  'oversized',
  'after_hours_pickup',
  'no_charge',
  'first_delivery',
  'isNextDelivery',
  'ampm_deliveries',
  'delivery_route_breadcrumbs',
  'finished_leg_encoded_polyline',
  'PolylineUpdated',
  // legacy / denormalized fields still used across the app
  'patient_name',
  'patient_phone',
  'store_phone',
  'time_window_start',
  'time_window_end',
  'unit_number'
]);

const INTERNAL_ONLY_FIELDS = new Set([
  'id',
  'created_date',
  'updated_date',
  'created_by',
  '_isLocal',
  '_tempId',
  '_isBatchSave',
  '_stagedDeliveries',
  'store_name',
  'store_abbreviation',
  'distanceFromStore',
  'delivery_address',
  'latitude',
  'longitude'
]);

const normalizeValue = (key, value) => {
  if (value === undefined) return undefined;
  if ((key === 'barcode_values' || key === 'receipt_barcode_values' || key === 'proof_photo_urls') && !Array.isArray(value)) {
    return [];
  }
  if (key === 'cod_payments' && value && !Array.isArray(value)) {
    return undefined;
  }
  return value;
};

export const sanitizeDeliveryPayload = (delivery = {}) => {
  return Object.entries(delivery).reduce((clean, [key, rawValue]) => {
    if (INTERNAL_ONLY_FIELDS.has(key)) return clean;
    if (!DELIVERY_ALLOWED_FIELDS.has(key)) return clean;

    const value = normalizeValue(key, rawValue);
    if (value === undefined) return clean;

    clean[key] = value;
    return clean;
  }, {});
};

export const sanitizeDeliveryPayloads = (deliveries = []) => deliveries.map(sanitizeDeliveryPayload);