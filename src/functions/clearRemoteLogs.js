import { base44 } from '@/api/base44Client';

export async function clearRemoteLogs(payload) {
  return await base44.functions.invoke('clearOldRemoteLogs', payload || {});
}
