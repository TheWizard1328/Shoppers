import { useCallback, useEffect } from 'react';
import { scanPrescriptionLabel, handlePrescriptionScanResult } from './prescriptionScanHelpers';

// ── Simple camera selection for PWA/Chrome ──
// No probing (opening multiple streams is flaky in Chrome PWA).
// Strategy:
//   1. If we have a saved preferred deviceId (localStorage), use it directly.
//   2. Otherwise open with facingMode:ideal (safe, picks a rear cam).
//   3. The UI provides a "Switch Camera" button to cycle through cameras.
//   4. When user picks a camera, we save it to localStorage for next time.

const SAVED_CAM_KEY = 'rxdeliver_preferred_camera_id';

const getSavedCameraId = () => {
  try { return localStorage.getItem(SAVED_CAM_KEY) || null; } catch { return null; }
};

const saveCameraId = (id) => {
  try { if (id) localStorage.setItem(SAVED_CAM_KEY, id); } catch {}
};

// Open a stream with a specific deviceId, or fall back to facingMode:ideal
const openStream = async (deviceId) => {
  if (deviceId) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
        audio: false
      });
    } catch {
      // exact deviceId failed — clear saved and fall through to facingMode
      saveCameraId(null);
    }
  }
  return await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
    audio: false
  });
};

// Get list of video devices (call AFTER permission is granted)
const listCameras = async () => {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter(d => d.kind === 'videoinput');
  } catch { return []; }
};

// Cycle to the next camera and return the new stream
const switchToNextCamera = async (currentDeviceId) => {
  const cams = await listCameras();
  // Filter to cameras that actually have a deviceId
  const validCams = cams.filter(c => c.deviceId);
  if (validCams.length <= 1) {
    console.warn('[camera] Cannot switch — only', validCams.length, 'cameras with deviceIds');
    return null;
  }

  // Find current index (or default to -1 so next = 0)
  let currentIdx = validCams.findIndex(c => c.deviceId === currentDeviceId);
  if (currentIdx === -1) currentIdx = -1; // unknown — start from beginning

  const nextIdx = (currentIdx + 1) % validCams.length;
  const nextCam = validCams[nextIdx];
  console.log('[camera] Switching from idx', currentIdx, 'to idx', nextIdx, ':', nextCam.label || nextCam.deviceId.slice(0, 8));

  saveCameraId(nextCam.deviceId);
  return openStream(nextCam.deviceId);
};

export { openStream, listCameras, switchToNextCamera, getSavedCameraId, saveCameraId, SAVED_CAM_KEY };

const startCameraWithStream = async () => {
  const savedId = getSavedCameraId();
  return openStream(savedId);
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
      const stream = await startCameraWithStream();
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
