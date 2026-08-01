import { useCallback, useEffect, useRef } from 'react';
import { scanPrescriptionLabel, handlePrescriptionScanResult } from './prescriptionScanHelpers';

// ── Sharpness detection via luminance variance ──
// Captures a small downsampled frame and computes Laplacian variance.
// High variance = sharp/detail (text present). Low variance = blurry/blank.
const computeSharpness = (video) => {
  try {
    const w = 160, h = 90;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, w, h);
    const imageData = ctx.getImageData(0, 0, w, h);
    const pixels = imageData.data;

    // Compute luminance for each pixel
    const lum = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const r = pixels[i * 4];
      const g = pixels[i * 4 + 1];
      const b = pixels[i * 4 + 2];
      lum[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    }

    // Laplacian: |4*p - p_up - p_down - p_left - p_right|
    let sumLaplacian = 0;
    let count = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const idx = y * w + x;
        const lap = Math.abs(
          4 * lum[idx] - lum[idx - 1] - lum[idx + 1] - lum[idx - w] - lum[idx + w]
        );
        sumLaplacian += lap;
        count++;
      }
    }

    return count > 0 ? sumLaplacian / count : 0;
  } catch {
    return 0;
  }
};

// Build camera constraints optimized for prescription label capture
const buildLabelCameraConstraints = async () => {
  // Try to find the back camera by deviceId for reliability
  let selectedDeviceId = null;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videos = devices.filter(d => d.kind === 'videoinput');
    const back = videos.find(d => /back|rear|environment/i.test(d.label));
    selectedDeviceId = (back || videos[videos.length - 1])?.deviceId || null;
  } catch {}

  if (selectedDeviceId) {
    return {
      video: {
        deviceId: { exact: selectedDeviceId },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30 }
      },
      audio: false
    };
  }
  return {
    video: {
      facingMode: { exact: 'environment' },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 30 }
    },
    audio: false
  };
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
  const autoCaptureTimerRef = useRef(null);
  const sharpnessHistoryRef = useRef([]);
  const bestFrameRef = useRef(null);
  const isAutoCapturingRef = useRef(false);

  const startCamera = useCallback(async () => {
    try {
      const constraints = await buildLabelCameraConstraints();
      const stream = await navigator.mediaDevices.getUserMedia(constraints);

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
        setIsCameraActive(true);

        // Auto-capture loop: check sharpness every 400ms
        // Auto-capture when 3 consecutive frames are sharp (stable + in focus)
        sharpnessHistoryRef.current = [];
        bestFrameRef.current = null;
        isAutoCapturingRef.current = false;

        autoCaptureTimerRef.current = setInterval(() => {
          if (isAutoCapturingRef.current || !videoRef.current || videoRef.current.readyState < 2) return;

          const sharpness = computeSharpness(videoRef.current);
          const SHARP_THRESHOLD = 12; // empirically tuned for text labels
          sharpnessHistoryRef.current.push(sharpness);
          if (sharpnessHistoryRef.current.length > 5) sharpnessHistoryRef.current.shift();

          // Track best frame
          if (!bestFrameRef.current || sharpness > bestFrameRef.current.sharpness) {
            bestFrameRef.current = { sharpness, time: Date.now() };
          }

          // Auto-capture: 3 consecutive sharp frames
          const recent = sharpnessHistoryRef.current.slice(-3);
          if (recent.length >= 3 && recent.every(s => s > SHARP_THRESHOLD)) {
            console.log('[PrescriptionScan] Auto-capturing — sharpness:', recent);
            isAutoCapturingRef.current = true;
            clearInterval(autoCaptureTimerRef.current);
            autoCaptureTimerRef.current = null;
            // Call the capture handler directly
            captureAndScan();
          }
        }, 400);
      }
    } catch (err) {
      console.error('Error accessing camera:', err);
      setError('Could not access camera. Please check permissions.');
      setIsCameraActive(false);
      setShowCameraOverlay(false);
    }
  }, [videoRef, setIsCameraActive, setError, setShowCameraOverlay]);

  const stopCamera = useCallback(() => {
    if (autoCaptureTimerRef.current) {
      clearInterval(autoCaptureTimerRef.current);
      autoCaptureTimerRef.current = null;
    }
    if (videoRef.current && videoRef.current.srcObject) {
      videoRef.current.srcObject.getTracks().forEach((track) => track.stop());
      videoRef.current.srcObject = null;
    }
    setIsCameraActive(false);
    isAutoCapturingRef.current = false;
    sharpnessHistoryRef.current = [];
    bestFrameRef.current = null;
  }, [videoRef, setIsCameraActive]);

  const captureAndScan = useCallback(async () => {
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
        // Use fileUrl mode — uploads once, skips the base64 double-upload in the backend
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
        console.error('Error scanning prescription:', error);
        setError(`Scan failed: ${error.message}`);
      } finally {
        setIsScanning(false);
        stopCamera();
        setShowCameraOverlay(false);
      }
    }, 'image/jpeg', 0.85);
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

  // Keep handleCameraCapture as an alias for backward compatibility (manual capture button)
  const handleCameraCapture = captureAndScan;

  useEffect(() => () => stopCamera(), [stopCamera]);

  return { startCamera, stopCamera, handleCameraCapture };
}
