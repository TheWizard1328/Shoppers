import { base44 } from '@/api/base44Client';

export async function setDriverStatus(payload) {
  return await base44.functions.invoke('setDriverStatus', payload || {});
}

export default setDriverStatus;
