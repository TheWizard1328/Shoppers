import { base44 } from '@/api/base44Client';

export async function purgeAndRegeneratePolylines(payload) {
  return await base44.functions.invoke('purgeAndRegeneratePolylines', payload || {});
}