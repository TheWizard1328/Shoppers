import { base44 } from '@/api/base44Client';

export async function refreshDriverEtasOnLocationUpdate(payload) {
  return await base44.functions.invoke('refreshDriverEtasOnLocationUpdate', payload || {});
}