import { getEffectiveUser } from './auth';

let actorCache = {
  data: null,
  timestamp: 0
};

const ACTOR_CACHE_TTL = 5 * 60 * 1000;

export const getIntegrationActor = async () => {
  if (actorCache.data && Date.now() - actorCache.timestamp < ACTOR_CACHE_TTL) {
    return actorCache.data;
  }

  const actor = await getEffectiveUser().catch(() => null);
  actorCache = {
    data: actor,
    timestamp: Date.now()
  };
  return actor;
};

const extractActualCreditsUsed = (result) => {
  return Number(
    result?.actual_platform_credits_used ??
    result?.data?.actual_platform_credits_used ??
    result?.usage?.credits_used ??
    result?.usage?.credits ??
    result?.data?.usage?.credits_used ??
    result?.data?.usage?.credits ??
    0
  ) || undefined;
};

export const buildIntegrationMetadata = (payload = {}, extra = {}) => {
  const normalizedPayload = payload && typeof payload === 'object' ? payload : {};
  return {
    payload_keys: Object.keys(normalizedPayload),
    model: normalizedPayload.model || undefined,
    add_context_from_internet: normalizedPayload.add_context_from_internet === true,
    has_response_json_schema: !!normalizedPayload.response_json_schema,
    file_count: Array.isArray(normalizedPayload.file_urls)
      ? normalizedPayload.file_urls.length
      : normalizedPayload.file_urls ? 1 : 0,
    page_path: typeof window !== 'undefined' ? window.location.pathname : undefined,
    ...extra,
  };
};

const persistIntegrationUsageLog = async (client, payload) => {
  try {
    await client.entities.IntegrationUsageLog.create(payload);
  } catch (error) {
    console.warn('Failed to persist integration usage log:', error?.message || error);
  }
};

export const withIntegrationTracking = async ({
  client,
  integrationName,
  operationName,
  feature = null,
  metadata = {},
  estimatedCreditsUsed = 1,
  call,
}) => {
  const startedAt = Date.now();
  const actor = await getIntegrationActor();
  const basePayload = {
    timestamp: new Date().toISOString(),
    integration_name: integrationName,
    operation_name: operationName,
    feature: feature || metadata?.task_name || metadata?.page_path || null,
    app_user_id: actor?.id || null,
    app_user_name: actor?.user_name || actor?.full_name || null,
    auth_user_id: actor?.user_id || actor?.id || null,
    estimated_credits_used: Number(estimatedCreditsUsed) || 1,
    metadata,
  };

  globalThis.__base44IntegrationTrackingActive = (globalThis.__base44IntegrationTrackingActive || 0) + 1;

  try {
    const result = await call();
    const duration = Date.now() - startedAt;
    const actualCredits = extractActualCreditsUsed(result);

    client.analytics.track({
      eventName: 'integration_usage',
      properties: {
        integration_name: integrationName,
        operation_name: operationName,
        feature: feature || null,
        success: true,
        duration_ms: duration,
        estimated_credits_used: Number(estimatedCreditsUsed) || 1,
        actual_platform_credits_used: actualCredits || null,
        ...metadata,
      }
    });

    persistIntegrationUsageLog(client, {
      ...basePayload,
      success: true,
      duration_ms: duration,
      actual_platform_credits_used: actualCredits,
    });

    return result;
  } catch (error) {
    const duration = Date.now() - startedAt;

    client.analytics.track({
      eventName: 'integration_usage',
      properties: {
        integration_name: integrationName,
        operation_name: operationName,
        feature: feature || null,
        success: false,
        duration_ms: duration,
        estimated_credits_used: Number(estimatedCreditsUsed) || 1,
        error_message: error?.message || 'Unknown error',
        ...metadata,
      }
    });

    persistIntegrationUsageLog(client, {
      ...basePayload,
      success: false,
      duration_ms: duration,
      error_message: error?.message || 'Unknown error',
    });

    throw error;
  } finally {
    globalThis.__base44IntegrationTrackingActive = Math.max(0, (globalThis.__base44IntegrationTrackingActive || 1) - 1);
  }
};