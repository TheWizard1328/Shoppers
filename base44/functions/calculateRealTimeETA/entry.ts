import { base44 } from '@/api/base44Client';

export async function calculateRealTimeETA(payload) {
  return await base44.functions.invoke('calculateRealTimeETA', payload || {});
}