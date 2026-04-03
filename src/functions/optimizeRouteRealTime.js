import { base44 } from '@/api/base44Client';

export async function optimizeRouteRealTime(payload) {
  return await base44.functions.invoke('optimizeRouteRealTime', payload || {});
}