import { base44 } from '@/api/base44Client';

const FALLBACK_ALLOWED_FIELDS = new Set([
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
  'PolylineUpdated'
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
  '_wasEdited',
  'isNew',
  'store_name',
  'store_abbreviation',
  'distanceFromStore',
  'delivery_address',
  'latitude',
  'longitude',
  'patient_name',
  'patient_phone',
  'store_phone',
  'time_window_start',
  'time_window_end',
  'unit_number',
  'mailbox_ok',
  'call_upon_arrival',
  'ring_bell',
  'dont_ring_bell',
  'back_door',
  'recurring',
  'recurring_daily',
  'recurring_weekly_mon',
  'recurring_weekly_tue',
  'recurring_weekly_wed',
  'recurring_weekly_thu',
  'recurring_weekly_fri',
  'recurring_weekly_sat',
  'recurring_weekly_sun',
  'recurring_biweekly',
  'recurring_weekly_x4',
  'recurring_monthly',
  'recurring_bimonthly'
]);

let deliverySchemaPromise = null;

const getDeliverySchema = async () => {
  if (!deliverySchemaPromise) {
    const schemaLoader = base44?.entities?.Delivery?.schema;
    deliverySchemaPromise = typeof schemaLoader === 'function'
      ? schemaLoader().catch(() => null)
      : Promise.resolve(null);
  }
  return deliverySchemaPromise;
};

const normalizeValue = (key, value, fieldSchema) => {
  if (value === undefined) return undefined;
  if (value === null) {
    if (fieldSchema?.type === 'string') return '';
    if (fieldSchema?.type === 'array') return [];
    return undefined;
  }
  if ((key === 'barcode_values' || key === 'receipt_barcode_values' || key === 'proof_photo_urls') && !Array.isArray(value)) {
    return [];
  }
  if (key === 'cod_payments' && !Array.isArray(value)) {
    return undefined;
  }
  return value;
};

export const sanitizeDeliveryPayload = async (delivery = {}) => {
  const schema = await getDeliverySchema();
  const schemaProperties = schema?.properties || {};
  const allowedFields = Object.keys(schemaProperties).length > 0
    ? new Set(Object.keys(schemaProperties))
    : FALLBACK_ALLOWED_FIELDS;

  return Object.entries(delivery).reduce((clean, [key, rawValue]) => {
    if (INTERNAL_ONLY_FIELDS.has(key)) return clean;
    if (!allowedFields.has(key)) return clean;

    const value = normalizeValue(key, rawValue, schemaProperties[key]);
    if (value === undefined) return clean;

    clean[key] = value;
    return clean;
  }, {});
};

export const sanitizeDeliveryPayloads = async (deliveries = []) => Promise.all((deliveries || []).map((delivery) => sanitizeDeliveryPayload(delivery)));