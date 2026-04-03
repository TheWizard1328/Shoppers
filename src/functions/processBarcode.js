import { base44 } from '@/api/base44Client';

export async function processBarcode(payload) {
  return await base44.functions.invoke('processBarcode', payload || {});
}