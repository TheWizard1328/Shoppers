import { base44 } from '@/api/base44Client';

export async function squareSyncCatalogItems(payload) {
  return await base44.functions.invoke('squareSyncCatalogItems', payload || {});
}

export default squareSyncCatalogItems;
