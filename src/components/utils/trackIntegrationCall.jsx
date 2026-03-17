import { base44 } from '@/api/base44Client';
import { getEffectiveUser } from './auth';

let actorCache = {
  data: null,
  timestamp: 0
};

const ACTOR_CACHE_TTL = 5 * 60 * 1000;

const getActor = async () => {
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

const logUsageRecord = async (payload) => {
  try {
    await base44.entities.IntegrationUsageLog.create(payload);
  } catch (error) {
    console.warn('Failed to persist integration usage log:', error?.message || error);
  }
};

export async function trackIntegrationCall({ integrationName, operationName, feature = null, metadata = {}, estimatedCreditsUsed = 1, call }) {
  const startedAt = Date.now();
  const actor = await getActor();
  const basePayload = {
    timestamp: new Date().toISOString(),
    integration_name: integrationName,
    operation_name: operationName,
    feature: feature || metadata?.task_name || null,
    app_user_id: actor?.id || null,
    app_user_name: actor?.user_name || actor?.full_name || null,
    auth_user_id: actor?.user_id || actor?.id || null,
    estimated_credits_used: Number(estimatedCreditsUsed) || 1,
    metadata,
  };

  try {
    const result = await call();
    const duration = Date.now() - startedAt;
    base44.analytics.track({
      eventName: 'integration_usage',
      properties: {
        integration_name: integrationName,
        operation_name: operationName,
        feature,
        success: true,
        duration_ms: duration,
        estimated_credits_used: Number(estimatedCreditsUsed) || 1,
        ...metadata,
      }
    });
    logUsageRecord({
      ...basePayload,
      success: true,
      duration_ms: duration,
    });
    return result;
  } catch (error) {
    const duration = Date.now() - startedAt;
    base44.analytics.track({
      eventName: 'integration_usage',
      properties: {
        integration_name: integrationName,
        operation_name: operationName,
        feature,
        success: false,
        duration_ms: duration,
        estimated_credits_used: Number(estimatedCreditsUsed) || 1,
        ...metadata,
      }
    });
    logUsageRecord({
      ...basePayload,
      success: false,
      duration_ms: duration,
      error_message: error?.message || 'Unknown error',
    });
    throw error;
  }
}