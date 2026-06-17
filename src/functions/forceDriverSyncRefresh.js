import { base44 } from '@/api/base44Client';

export async function forceDriverSyncRefresh(payload) {
  return await base44.functions.invoke('forceDriverSyncRefresh', payload || {});
}
