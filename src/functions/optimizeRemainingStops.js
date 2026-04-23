import { base44 } from '@/api/base44Client';

export async function optimizeRemainingStops(payload) {
  return await base44.functions.invoke('optimizeRemainingStops', payload || {});
}

export default optimizeRemainingStops;