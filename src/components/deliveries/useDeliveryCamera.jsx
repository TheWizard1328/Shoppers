import { useCallback, useEffect } from 'react';
import { scanPrescriptionLabel, handlePrescriptionScanResult } from './prescriptionScanHelpers';

// Pick the best rear camera — tries all back-facing devices and picks highest resolution.
// Falls back to a user-selectable camera index stored in localStorage.
// Priority: highest-res back cam > label heuristic > index 1 > any back cam
const getBestBackCameraId = async () => {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter(d => d.kind === 'videoinput');
    if (cams.length === 0) return null;

    // Try to get resolution of each back-facing candidate
    const backCams = cams.filter(d => {
      const lbl = d.label.toLowerCase();
      // Include unlabelled cameras — we'll test them all
      return lbl === '' || /back|rear|environment/i.test(lbl);
    });

    const candidates = backCams.length > 0 ? backCams : cams;

    // Prefer label-based: has back/rear but NOT wide/ultra/tele
    const main1x = candidates.find(d => /back|rear/i.test(d.label) && !/wide|ultra|tele|0\.6|0\.5/i.test(d.label));
    if (main1x?.deviceId) {
      console.log('[camera] Label heuristic selected:', main1x.label);
      return main1x.deviceId;
    }

    // Try resolution-based: open each candidate briefly, pick highest native res
    let bestId = null;
    let bestPixels = 0;
    for (const cam of candidates) {
      if (!cam.deviceId) continue;
      let testStream = null;
      try {
        testStream = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: { exact: cam.deviceId }, width: { ideal: 3840 }, height: { ideal: 2160 } },
          audio: false
        });
        const track = testStream.getVideoTracks()[0];
        const s = track.getSettings();
        const pixels = (s.width || 0) * (s.height || 0);
        console.log('[camera] Candidate:', cam.label || cam.deviceId.slice(0,8), `${s.width}x${s.height}`, pixels);
        if (pixels > bestPixels) {
          bestPixels = pixels;
          bestId = cam.deviceId;
        }
      } catch {}
      finally {
        testStream?.getTracks().forEach(t => t.stop());
      }
    }
    if (bestId) {
      console.log('[camera] Resolution heuristic selected deviceId:', bestId.slice(0,8), 'pixels:', bestPixels);
      return bestId;
    }

    // Fallback: second camera (most Android: 0=ultra-wide, 1=main)
    const byIndex = cams.length >= 2 ? cams[1] : cams[0];
    return byIndex?.deviceId || null;
  } catch (e) {
    console.warn('[camera] getBestBackCameraId failed:', e?.message);
    return null;
  }
};

// Cached so we don't re-probe every time
let _cachedCameraId = null;

const getMainCameraStream = async () => {
  // Step 1: open with facingMode:ideal to trigger permission prompt
  const safeStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    audio: false
  });

  // Step 2: after permission, probe for best camera (cached after first call)
  if (!_cachedCameraId) {
    _cachedCameraId = await getBestBackCameraId();
  }

  if (_cachedCameraId) {
    const currentId = safeStream.getVideoTracks()[0]?.getSettings?.()?.deviceId;
    if (currentId !== _cachedCameraId) {
      try {
        safeStream.getTracks().forEach(t => t.stop());
        const betterStream = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: { exact: _cachedCameraId }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
          audio: false
        });
        console.log('[camera] Switched to best camera:', _cachedCameraId.slice(0,8));
        return betterStream;
      } catch (e) {
        console.warn('[camera] Exact deviceId failed, using safe stream:', e?.message);
        _cachedCameraId = null; // reset so we re-probe next time
        return await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false
        });
      }
    }
  }

  return safeStream;
};

export { getMainCameraStream, getBestBackCameraId };

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
