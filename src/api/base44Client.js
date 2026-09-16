import { createClient } from '@base44/sdk';
import { appParams } from '@/lib/app-params';
import { installTestModeWriteGuard } from '@/components/utils/testMode';

const { appId, serverUrl, token, functionsVersion } = appParams;

export const base44 = createClient({
  appId,
  serverUrl,
  token,
  functionsVersion,
  requiresAuth: false
});

// Test Mode write guard (App Owner "Test as Dispatcher") — blocks entity
// writes + mutating backend functions while Test Mode is active. Installs
// here so every module importing `base44` (including ones that cache entity
// handlers at import time, e.g. dataManagerEntities) gets the guarded proxy.
installTestModeWriteGuard(base44);
