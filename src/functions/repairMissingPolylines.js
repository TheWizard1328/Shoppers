import { base44 } from '@/api/base44Client';

export async function repairMissingPolylines(payload) {
  return await base44.functions.invoke('repairMissingPolylines', payload || {});
}

export default repairMissingPolylines;