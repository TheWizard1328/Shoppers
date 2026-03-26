import { format } from 'date-fns';
import { base44 } from '@/api/base44Client';
import { requestThrottler } from './requestThrottler';

/**
 * CRITICAL: Atomic device registration check
 * Ensures device status is definitively established before proceeding
 * 
 * Returns: { isRegistered: boolean, manifest: object, uncertain?: boolean, error?: object }
 */
export const performAtomicDeviceCheck = async (deviceIdentifier) => {
  try {
    const cachedRegistration = localStorage.getItem(`rxdeliver_device_registered_${deviceIdentifier}`);
    
    // CRITICAL: If cached as registered, do a quick backend verification
    if (cachedRegistration === 'true') {
      try {
        const todayStr = format(new Date(), 'yyyy-MM-dd');
         const manifestResponse = await requestThrottler.queue(
           () => base44.functions.invoke('getBootstrapManifest', { deviceIdentifier, todayStr }),
           'critical',
           'verifyDeviceRegistration'
         );
        
        const manifest = manifestResponse?.data || manifestResponse || {};
        
        // Backend confirms registration - device is good
        if (manifest?.deviceRegistered === true) {
          return { isRegistered: true, manifest };
        }
        
        // Backend says NOT registered - clear cache and proceed to registration
        localStorage.removeItem(`rxdeliver_device_registered_${deviceIdentifier}`);
        return { isRegistered: false, manifest: {} };
      } catch (error) {
        // Network error during verification - trust the cache but mark as uncertain
        console.warn('⚠️ [AtomicDeviceCheck] Could not verify with backend, trusting cache:', error.message);
        return { isRegistered: true, manifest: {}, uncertain: true };
      }
    }
    
    // Not cached - need to get fresh status from backend
     const todayStr = format(new Date(), 'yyyy-MM-dd');
     const manifestResponse = await requestThrottler.queue(
       () => base44.functions.invoke('getBootstrapManifest', { deviceIdentifier, todayStr }),
       'critical',
       'getBootstrapManifest'
     );
    
    const manifest = manifestResponse?.data || manifestResponse || {};
    
    if (manifest?.deviceRegistered === true) {
      localStorage.setItem(`rxdeliver_device_registered_${deviceIdentifier}`, 'true');
      return { isRegistered: true, manifest };
    }
    
    return { isRegistered: false, manifest };
  } catch (error) {
    console.error('❌ [AtomicDeviceCheck] Device check failed:', error);
    return { isRegistered: false, manifest: {}, error };
  }
};