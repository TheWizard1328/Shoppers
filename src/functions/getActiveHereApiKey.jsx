import { base44 } from '@/api/base44Client';

export async function getActiveHereApiKey(payload) {
  return await base44.functions.invoke('getActiveHereApiKey', payload || {});
}