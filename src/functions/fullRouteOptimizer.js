import { base44 } from '@/api/base44Client';

export async function fullRouteOptimizer(payload) {
  return await base44.functions.invoke('fullRouteOptimizer', payload || {});
}

export default fullRouteOptimizer;
