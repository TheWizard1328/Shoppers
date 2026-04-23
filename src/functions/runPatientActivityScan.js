import { base44 } from '@/api/base44Client';

export async function runPatientActivityScan(payload) {
  return await base44.functions.invoke('runPatientActivityScan', payload || {});
}