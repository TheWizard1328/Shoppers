import { base44 } from '@/api/base44Client';

export async function saveCrumbPolylineToDelivery(payload) {
  const result = await base44.functions.invoke('saveCrumbPolylineToDelivery', payload || {});
  const deliveryId = result?.data?.deliveryId;
  if (deliveryId) {
    window.dispatchEvent(new CustomEvent('forceInvalidateDelivery', { detail: { deliveryId } }));
  }
  return result;
}

export default saveCrumbPolylineToDelivery;