import { updateDeliveryLocal } from './offlineMutations';

export async function persistDeliveryProof(deliveryId, updates) {
  return updateDeliveryLocal(deliveryId, updates, { skipSmartRefresh: true });
}
