import { base44 } from '@/api/base44Client';

export async function trackIntegrationCall({ integrationName, operationName, feature = null, metadata = {}, call }) {
  const startedAt = Date.now();

  try {
    const result = await call();
    base44.analytics.track({
      eventName: 'integration_usage',
      properties: {
        integration_name: integrationName,
        operation_name: operationName,
        feature,
        success: true,
        duration_ms: Date.now() - startedAt,
        ...metadata,
      }
    });
    return result;
  } catch (error) {
    base44.analytics.track({
      eventName: 'integration_usage',
      properties: {
        integration_name: integrationName,
        operation_name: operationName,
        feature,
        success: false,
        duration_ms: Date.now() - startedAt,
        ...metadata,
      }
    });
    throw error;
  }
}