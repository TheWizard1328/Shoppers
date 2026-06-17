import { base44 } from '@/api/base44Client';

export async function saveCrumbPolylineToDelivery(payload) {
  return await base44.functions.invoke('saveCrumbPolylineToDelivery', payload || {});
}

export default saveCrumbPolylineToDelivery;
