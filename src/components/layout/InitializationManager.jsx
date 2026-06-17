import React, { useEffect, useCallback } from 'react';
import { format } from 'date-fns';
import { getEffectiveUser, clearUserCache } from '../utils/auth';
import { getDeviceType, getDeviceIdentifier } from '../utils/userSettingsManager';
import { performAtomicDeviceCheck } from '../utils/atomicDeviceCheck';
import { requestThrottler } from '../utils/requestThrottler';
import { getBootstrapManifest } from '@/functions/getBootstrapManifest';

/**
 * CRITICAL: Handles the unified initialization flow
 * Keeps isLoadingLayout = true until ALL prerequisites are met
 * This prevents partial UI rendering and reload loops
 */
export const useInitialization = ({
  setIsLoadingLayout,
  setDataLoaded,
  setCurrentUser,
  setHasAccess,
  setDeviceTypeDetected,
  setShowDeviceSelectionModal,
  setDeviceRegistered,
  onInitComplete
}) => {
  const performInitialization = useCallback(async () => {
    setIsLoadingLayout(true);

    try {
      // STEP 1: Detect device type
      const detectedDeviceType = getDeviceType();
      setDeviceTypeDetected(detectedDeviceType);

      // STEP 2: Authenticate user
      const fetchedUser = await requestThrottler.queue(
        () => getEffectiveUser(),
        'critical',
        'getEffectiveUser'
      );

      if (!fetchedUser) {
        setHasAccess(false);
        setCurrentUser(null);
        setIsLoadingLayout(false);
        setDataLoaded(true);
        return;
      }

      // STEP 3: Atomic device registration check
      const deviceIdentifier = getDeviceIdentifier();
      const deviceCheckResult = await performAtomicDeviceCheck(deviceIdentifier);
      
      if (!deviceCheckResult.isRegistered) {
        // Device NOT registered - show registration modal but KEEP loading state active
        console.log('📱 [InitManager] Device not registered, showing registration modal');
        setCurrentUser(fetchedUser);
        setShowDeviceSelectionModal(true);
        
        // CRITICAL: Keep isLoadingLayout = true while waiting for device registration
        // This prevents any UI from rendering until registration completes
        // When handleDeviceSelected is called, it will reload the page and restart this init
        return;
      }

      // Device IS registered - proceed with full initialization
      setDeviceRegistered(true);
      const manifest = deviceCheckResult.manifest || {};

      // STEP 4: User is authenticated and device is registered - safe to proceed
      setCurrentUser(fetchedUser);
      setHasAccess(true);

      // STEP 5: Dispatch initialization complete event with manifest data
      // The main layout component will handle loading app data from here
      onInitComplete?.({ user: fetchedUser, manifest, deviceIdentifier });

      // CRITICAL: Set loading to false only after all prerequisites are confirmed
      setIsLoadingLayout(false);
      setDataLoaded(true);

    } catch (error) {
      // CRITICAL: Handle auth errors separately from other errors
      const isAuthError = error.response?.status === 401 || error.response?.status === 403 ||
        error.message?.includes('Unauthorized') || error.message?.includes('Forbidden');

      if (isAuthError) {
        setHasAccess(false);
      } else {
        // Non-auth error - allow app to load but log warning
        console.warn('⚠️ [InitManager] Non-auth error during init:', error?.message || error);
        setHasAccess(true);
      }

      setIsLoadingLayout(false);
      setDataLoaded(true);
    }
  }, [setIsLoadingLayout, setDataLoaded, setCurrentUser, setHasAccess, setDeviceTypeDetected, setShowDeviceSelectionModal, setDeviceRegistered, onInitComplete]);

  return { performInitialization };
};