import { createClient } from '@base44/sdk';
import { appParams } from '@/lib/app-params';

const buildClient = () => {
  const { appId, serverUrl, token, functionsVersion } = appParams;

  return createClient({
    appId,
    serverUrl,
    token: token || window.localStorage.getItem('base44_token') || window.sessionStorage.getItem('base44_token') || null,
    functionsVersion,
    requiresAuth: false
  });
};

export const base44 = buildClient();