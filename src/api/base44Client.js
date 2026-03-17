import { createClient } from '@base44/sdk';
import { appParams } from '@/lib/app-params';
import { withIntegrationTracking, buildIntegrationMetadata } from '@/components/utils/integrationUsageLogger';

const { appId, serverUrl, token, functionsVersion } = appParams;

const rawBase44 = createClient({
  appId,
  serverUrl,
  token,
  functionsVersion,
  requiresAuth: false
});

const wrapIntegrations = (client) => {
  if (!client?.integrations || client.__integrationTrackingWrapped) return client;

  Object.entries(client.integrations).forEach(([integrationName, operations]) => {
    if (!operations || typeof operations !== 'object') return;

    Object.entries(operations).forEach(([operationName, originalOperation]) => {
      if (typeof originalOperation !== 'function' || originalOperation.__integrationTrackingWrapped) return;

      const wrappedOperation = async (payload) => {
        if ((globalThis.__base44IntegrationTrackingActive || 0) > 0) {
          return originalOperation.call(operations, payload);
        }

        return withIntegrationTracking({
          client,
          integrationName,
          operationName,
          feature: typeof window !== 'undefined' ? window.location.pathname : null,
          metadata: buildIntegrationMetadata(payload),
          estimatedCreditsUsed: 1,
          call: () => originalOperation.call(operations, payload),
        });
      };

      wrappedOperation.__integrationTrackingWrapped = true;
      operations[operationName] = wrappedOperation;
    });
  });

  client.__integrationTrackingWrapped = true;
  return client;
};

export const base44 = wrapIntegrations(rawBase44);