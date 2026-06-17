import { base44 } from '@/api/base44Client';

export async function getGoogleDrivingDistance(payload) {
  return await base44.functions.invoke('getGoogleDrivingDistance', payload || {});
}

export default getGoogleDrivingDistance;
