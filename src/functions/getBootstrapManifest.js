import { base44 } from '@/api/base44Client';

export async function getBootstrapManifest(payload) {
  return await base44.functions.invoke('getBootstrapManifest', payload || {});
}