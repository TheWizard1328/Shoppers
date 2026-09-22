import axios from 'axios';
import { createClient } from '@base44/sdk';
import { appParams } from '@/lib/app-params';
import { connectionMonitor } from '@/components/utils/connectionMonitor';

const { appId, serverUrl, token, functionsVersion } = appParams;

// The SDK creates its own Axios instances from the shared defaults. A hard
// timeout prevents a black-holed cellular connection from leaving UI actions,
// auth/bootstrap, GPS uploads, or sync queues pending forever.
axios.defaults.timeout = 15000;

const classifyConnectionError = (error) => {
  const message = String(error?.message || '').toLowerCase();
  const status = Number(error?.status || error?.response?.status || error?.code);
  if (status === 429 || message.includes('rate limit')) return 'rate_limit';
  if (error?.code === 'ECONNABORTED' || message.includes('timeout')) return 'timeout';
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'offline';
  if (!status || message.includes('network') || message.includes('fetch')) return 'network';
  return null;
};

export const base44 = createClient({
  appId,
  serverUrl,
  token,
  functionsVersion,
  requiresAuth: false,
  options: {
    onError: (error) => {
      const connectionErrorType = classifyConnectionError(error);
      if (!connectionErrorType) return;
      connectionMonitor.recordError(connectionErrorType);
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('connectionError', {
          detail: { errorType: connectionErrorType, message: error?.message || 'Connection error' }
        }));
      }
    }
  }
});
