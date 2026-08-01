import { useCallback, useEffect } from 'react';
import { scanPrescriptionLabel, handlePrescriptionScanResult } from './prescriptionScanHelpers';

// Get the main (1x) rear camera stream — avoids grabbing the ultra-wide (0.6x) lens.
// Strategy:
//   1. Open with facingMode:ideal (safe, never hard-rejects) to trigger permission prompt
//   2. Enumerate devices AFTER permission is granted (labels only populated post-grant)
//   3. Prefer a camera labelled "back"/"rear" WITHOUT "wide"/"ultra"/"tele" = main 1x sensor
//      On most Android phones: index 0 = ultra-wide (0.6x), index 1 = main (1x)
//   4. Re-open with exact deviceId if a better camera was found
const getMainCameraStream = async () => {
  // Step 1: safe open — facingMode:ideal never hard-rejects
  const safeStream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 30 }
    },
    audio: false
  });

  // Step 2: enumerate now that permission is granted
  let targetDeviceId = null;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter(d => d.kind === 'videoinput');
    // Best: back/rear camera that is NOT ultra-wide/tele
    const main1x = cams.find(d => /back|rear/i.test(d.label) && !/wide|ultra|tele/i.test(d.label));
    // Fallback: second camera by index (most Android phones: 0=ultra-wide, 1=main)
    const byIndex = cams.length >= 2 ? cams[1] : null;
    // Last resort: any back-facing camera
    const anyBack = cams.find(d => /back|rear|environment/i.test(d.label));
    const chosen = main1x || byIndex || anyBack;
    targetDeviceId = chosen?.deviceId || null;
    console.log('[useDeliveryCamera] Cameras:', cams.map(c => `${c.label}(${c.deviceId?.slice(0,8)})`));
    console.log('[useDeliveryCamera] Selected:', chosen?.label || 'none');
  } catch (e) {
    console.warn('[useDeliveryCamera] enumerate failed:', e?.message);
  }

  // Step 3: re-open with exact deviceId if we found a better camera
  if (targetDeviceId) {
    const currentId = safeStream.getVideoTracks()[0]?.getSettings?.()?.deviceId;
    if (currentId !== targetDeviceId) {
      try {
        safeStream.getTracks().forEach(t => t.stop());
        const betterStream = await navigator.mediaDevices.getUserMedia({
          video: {
            deviceId: { exact: targetDeviceId },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
            frameRate: { ideal: 30 }
          },
          audio: false
        });
        return betterStream;
      } catch (err) {
        console.warn('[useDeliveryCamera] exact deviceId failed, re-opening safe stream:', err?.message);
        // Re-open safe stream since we stopped it
        return await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
            frameRate: { ideal: 30 }
          },
          audio: false
        });
      }
    }
  }

  return safeStream;
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
      const stream = await getMainCameraStream();

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        try { await videoRef.current.play(); } catch {}
        setIsCameraActive(true);
      }
    } catch (err) {
      console.error('[useDeliveryCamera] Camera open failed:', err);
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
        // fileUrl mode: upload once client-side, pass URL to backend (no base64 double-upload)
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
    videoRef,
    canvasRef,
    setError,
    setIsScanning,
    onCreatePatient,
    handlePatientSelect,
    setScanMatches,
    setShowMatchPopup,
    setExtractedData,
    setIsPatientFormOpen,
    stopCamera,
    setShowCameraOverlay
  ]);

  useEffect(() => () => stopCamera(), [stopCamera]);

  return { startCamera, stopCamera, handleCameraCapture };
}
