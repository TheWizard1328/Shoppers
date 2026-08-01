import { useCallback, useEffect } from 'react';
import { scanPrescriptionLabel, handlePrescriptionScanResult } from './prescriptionScanHelpers';

// ── Camera selection for PWA/Chrome ──
// Key rules for Android Chrome PWA:
//   1. Can't have two camera streams open at once — stop old BEFORE opening new
//   2. deviceId:exact can fail even for valid devices if a stream is still active
//   3. enumerateDevices labels may be empty — but deviceIds are stable
//   4. facingMode from track.getSettings() tells us if a camera is front ('user') or rear ('environment')

const SAVED_CAM_KEY = 'rxdeliver_preferred_camera_id';

const getSavedCameraId = () => {
  try { return localStorage.getItem(SAVED_CAM_KEY) || null; } catch { return null; }
};

const saveCameraId = (id) => {
  try { if (id) localStorage.setItem(SAVED_CAM_KEY, id); } catch {}
};

const listCameras = async () => {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter(d => d.kind === 'videoinput' && d.deviceId);
  } catch { return []; }
};

// Open a stream. If deviceId provided, try exact first, then ideal, then facingMode.
// Does NOT clear saved ID on failure — that's handled by caller.
const tryOpenStream = async (deviceId) => {
  if (deviceId) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
        audio: false
      });
    } catch {
      // exact failed — try ideal (won't hard-reject, picks closest match)
      try {
        return await navigator.mediaDevices.getUserMedia({
          video: { deviceId: { ideal: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
          audio: false
        });
      } catch {
        // both failed — fall through to facingMode
      }
    }
  }
  return await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
    audio: false
  });
};

// Cycle to the next REAR camera.
// MUST be called with the video element so we can stop the old stream first.
// Returns { stream, deviceId, label } or null if no switch happened.
const cycleRearCamera = async (videoEl) => {
  // Step 1: Get current stream info
  const oldStream = videoEl?.srcObject;
  const oldTrack = oldStream?.getVideoTracks?.()?.[0];
  const oldDeviceId = oldTrack?.getSettings?.()?.deviceId;
  const oldFacingMode = oldTrack?.getSettings?.()?.facingMode;

  // Step 2: Stop old stream FIRST — Android can't open two streams at once
  if (oldStream) {
    try { oldStream.getTracks().forEach(t => t.stop()); } catch {}
    if (videoEl) videoEl.srcObject = null;
  }

  // Step 3: Enumerate cameras
  const cams = await listCameras();
  if (cams.length <= 1) {
    console.warn('[camera] Only 1 camera — cannot switch');
    // Reopen the old stream since we stopped it
    return { stream: await tryOpenStream(oldDeviceId), deviceId: oldDeviceId, label: null, reopened: true };
  }

  // Step 4: Try each camera starting from the one after current.
  // Skip front cameras (facingMode === 'user') by opening and checking.
  const currentIdx = cams.findIndex(c => c.deviceId === oldDeviceId);
  console.log('[camera] Current idx:', currentIdx, 'total cams:', cams.length);

  for (let offset = 1; offset <= cams.length; offset++) {
    const tryIdx = ((currentIdx === -1 ? -1 : currentIdx) + offset) % cams.length;
    const cam = cams[tryIdx];
    console.log('[camera] Trying idx', tryIdx, ':', cam.label || cam.deviceId.slice(0, 8));

    let stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: cam.deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
        audio: false
      });
    } catch {
      console.log('[camera] Failed to open idx', tryIdx, '— skipping');
      continue;
    }

    // Check if it's a front camera — skip those
    const facingMode = stream.getVideoTracks()[0]?.getSettings?.()?.facingMode;
    if (facingMode === 'user') {
      console.log('[camera] idx', tryIdx, 'is front-facing — skipping');
      try { stream.getTracks().forEach(t => t.stop()); } catch {}
      continue;
    }

    // Found a rear camera!
    console.log('[camera] Switched to rear camera idx', tryIdx, ':', cam.label || cam.deviceId.slice(0, 8), 'facing:', facingMode);
    saveCameraId(cam.deviceId);
    return { stream, deviceId: cam.deviceId, label: cam.label, reopened: false };
  }

  // All cameras failed or all were front-facing — fall back to facingMode:ideal
  console.warn('[camera] All candidates failed — falling back to facingMode:ideal');
  const fallback = await tryOpenStream(null);
  return { stream: fallback, deviceId: null, label: null, reopened: true };
};

export { openStream, listCameras, cycleRearCamera, getSavedCameraId, saveCameraId, SAVED_CAM_KEY };

// Used by startCamera — tries saved deviceId first
const openStream = async (deviceId) => {
  return tryOpenStream(deviceId);
};

export default function useDeliveryCamera({
  videoRef,
  canvasRef,
  setIsCameraActive,
  setShowCameraOverlay,
  setIsScanning,
  setError,
  onCreatePatient,
  handlePatientSelect,
  setScanMatches,
  setShowMatchPopup,
  setExtractedData,
  setIsPatientFormOpen
}) {
  const startCamera = useCallback(async () => {
    try {
      const savedId = getSavedCameraId();
      const stream = await tryOpenStream(savedId);
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        try { await videoRef.current.play(); } catch {}
        setIsCameraActive(true);
      }
    } catch (err) {
      console.error('[useDeliveryCamera] Camera failed:', err);
      setError('Could not access camera. Please check permissions.');
      setIsCameraActive(false);
      setShowCameraOverlay(false);
    }
  }, [videoRef, setIsCameraActive, setError, setShowCameraOverlay]);

  const stopCamera = useCallback(() => {
    if (videoRef.current && videoRef.current.srcObject) {
      videoRef.current.srcObject.getTracks().forEach((track) => track.stop());
      videoRef.current.srcObject = null;
    }
    setIsCameraActive(false);
  }, [videoRef, setIsCameraActive]);

  const handleCameraCapture = useCallback(async () => {
    if (!videoRef.current || !canvasRef.current) {
      setError('Camera not ready');
      return;
    }

    setIsScanning(true);
    setError(null);

    const video = videoRef.current;
    const canvas = canvasRef.current;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    canvas.toBlob(async (blob) => {
      if (!blob) {
        setError('Failed to capture image');
        setIsScanning(false);
        return;
      }
      const file = new File([blob], 'prescription_scan.jpg', { type: 'image/jpeg' });
      try {
        const result = await scanPrescriptionLabel({ file, mode: 'fileUrl' });
        await handlePrescriptionScanResult({
          result,
          onCreatePatient,
          handlePatientSelect,
          setScanMatches,
          setShowMatchPopup,
          setExtractedData,
          setIsPatientFormOpen
        });
      } catch (error) {
        console.error('[useDeliveryCamera] Scan failed:', error);
        setError(`Scan failed: ${error.message}`);
      } finally {
        setIsScanning(false);
        stopCamera();
        setShowCameraOverlay(false);
      }
    }, 'image/jpeg', 0.92);
  }, [
    videoRef, canvasRef, setError, setIsScanning,
    onCreatePatient, handlePatientSelect, setScanMatches,
    setShowMatchPopup, setExtractedData, setIsPatientFormOpen,
    stopCamera, setShowCameraOverlay
  ]);

  useEffect(() => () => stopCamera(), [stopCamera]);

  return { startCamera, stopCamera, handleCameraCapture };
}
