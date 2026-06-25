import { base44 } from '@/api/base44Client';

const FALLBACK_ALLOWED_FIELDS = new Set([
  'company_id',
  'delivery_id',
  'patient_id',
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
  'encoded_polyline',
  'transport_mode',
  'finished_leg_transport_mode',
  'estimated_distance_km',
  'estimated_duration_minutes',
  'PolylineUpdated',
  'is_cycling_marker',
  'cycling_latitude',
  'cycling_longitude'
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
    // Allow explicit null for clearable string fields (time windows, etc.)
    // so they can be cleared on the backend. Other string fields fall back to ''.
    const NULLABLE_STRING_FIELDS = new Set(['delivery_time_start', 'delivery_time_end', 'delivery_time_eta', 'driver_id', 'puid']);
    if (NULLABLE_STRING_FIELDS.has(key)) return null;
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
  // Normalize delivery_date: strip ISO timestamp suffix → plain YYYY-MM-DD
  if (key === 'delivery_date' && typeof value === 'string' && value.length > 10 && value.includes('T')) {
    return value.slice(0, 10);
  }
  return value;
};

export const sanitizeDeliveryPayload = async (delivery = {}) => {
  const schema = await getDeliverySchema();
  const schemaProperties = schema?.properties || {};
  const allowedFields = Object.keys(schemaProperties).length > 0
    ? new Set(Object.keys(schemaProperties))
    : FALLBACK_ALLOWED_FIELDS;

  const clean = Object.entries(delivery).reduce((acc, [key, rawValue]) => {
    if (INTERNAL_ONLY_FIELDS.has(key)) return acc;
    if (!allowedFields.has(key)) return acc;

    const value = normalizeValue(key, rawValue, schemaProperties[key]);
    if (value === undefined) return acc;

    acc[key] = value;
    return acc;
  }, {});

  // Rule: pickups (no patient_id) that are not completed, cancelled, or failed must default to en_route
  const isPickup = !clean.patient_id && !delivery.patient_id;
  const PICKUP_TERMINAL_STATUSES = new Set(['completed', 'cancelled', 'failed']);
  if (isPickup && 'status' in clean) {
    const s = clean.status;
    if (!s || !PICKUP_TERMINAL_STATUSES.has(s)) {
      clean.status = 'en_route';
    }
  } else if (isPickup && !('status' in clean) && ('status' in delivery)) {
    // status key present in original but got stripped — still enforce
    const s = delivery.status;
    if (!s || !PICKUP_TERMINAL_STATUSES.has(s)) {
      clean.status = 'en_route';
    }
  }

  return clean;
};

export const sanitizeDeliveryPayloads = async (deliveries = []) => Promise.all((deliveries || []).map((delivery) => sanitizeDeliveryPayload(delivery)));