import { base44 } from '@/api/base44Client';

export async function deleteMyAccount(payload) {
  return await base44.functions.invoke('deleteMyAccount', payload || {});
}