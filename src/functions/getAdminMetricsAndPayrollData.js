import { base44 } from '@/api/base44Client';

export async function getAdminMetricsAndPayrollData(payload) {
  return await base44.functions.invoke('getAdminMetricsAndPayrollData', payload || {});
}

export default getAdminMetricsAndPayrollData;
