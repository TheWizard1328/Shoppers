import { base44 } from '@/api/base44Client';
import { withIntegrationTracking } from './integrationUsageLogger';


export async function trackIntegrationCall({ integrationName, operationName, feature = null, metadata = {}, estimatedCreditsUsed = 1, call }) {
  return withIntegrationTracking({
    client: base44,
    integrationName,
    operationName,
    feature,
    metadata,
    estimatedCreditsUsed,
    call,
  });
}