import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

const READ_BATCH_SIZE = 200;
const DELETE_BATCH_SIZE = 100;
const ALLOWED_FIELDS = [
  'driver_id',
  'driver_name',
  'delivery_date',
  'status',
  'store_id',
  'patient_id',
  'created_by_app_user_id',
  'stop_id',
  'puid',
  'ampm_deliveries'
];

const sanitizeQuery = (query) => {
  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    throw new Error('A query object is required');
  }

  const cleaned = {};
  for (const field of ALLOWED_FIELDS) {
    const value = query[field];
    if (value === undefined || value === null || value === '') continue;
    cleaned[field] = value;
  }

  if (Object.keys(cleaned).length === 0) {
    throw new Error('Query must include at least one supported filter');
  }

  return cleaned;
};

const listMatchingIds = async (base44, query) => {
  const matchedIds = [];
  let skip = 0;

  while (true) {
    const batch = await base44.asServiceRole.entities.Delivery.filter(query, '-updated_date', READ_BATCH_SIZE, skip);
    if (!batch || batch.length === 0) break;

    matchedIds.push(...batch.map((delivery) => delivery?.id).filter(Boolean));

    if (batch.length < READ_BATCH_SIZE) break;
    skip += READ_BATCH_SIZE;
  }

  return matchedIds;
};

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const payload = await req.json().catch(() => ({}));
    const query = sanitizeQuery(payload?.query);
    const dryRun = payload?.dryRun === true;

    const matchedIds = await listMatchingIds(base44, query);

    if (dryRun) {
      return Response.json({
        success: true,
        dryRun: true,
        query,
        matched_count: matchedIds.length,
        deleted_count: 0,
        failed_count: 0,
        failed_ids: []
      });
    }

    let deletedCount = 0;
    const failedIds = [];

    for (let index = 0; index < matchedIds.length; index += DELETE_BATCH_SIZE) {
      const currentBatch = matchedIds.slice(index, index + DELETE_BATCH_SIZE);
      const results = await Promise.allSettled(
        currentBatch.map((id) => base44.asServiceRole.entities.Delivery.delete(id))
      );

      results.forEach((result, batchIndex) => {
        const id = currentBatch[batchIndex];
        if (result.status === 'fulfilled') {
          deletedCount += 1;
        } else {
          failedIds.push(id);
        }
      });
    }

    return Response.json({
      success: failedIds.length === 0,
      dryRun: false,
      query,
      matched_count: matchedIds.length,
      deleted_count: deletedCount,
      failed_count: failedIds.length,
      failed_ids: failedIds
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});