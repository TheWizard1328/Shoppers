import React, { useState, useCallback, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Camera, SwitchCamera, X, Check, User, Phone, MapPin, AlertCircle, Zap, ScanLine } from "lucide-react";
import { listCameras, cycleRearCamera } from "./useDeliveryCamera";
import { scanPrescriptionLabel } from "./prescriptionScanHelpers";
import { formatPhoneNumber } from "../utils/phoneFormatter";

// ── Laplacian sharpness ──
const calculateSharpness = (canvas, ctx) => {
  const w = canvas.width;
  const h = canvas.height;
  const scale = Math.min(1, 240 / Math.max(w, h));
  const sw = Math.round(w * scale);
  const sh = Math.round(h * scale);
  const imageData = ctx.getImageData(0, 0, sw, sh > 0 ? sh : 1);
  const data = imageData.data;
  const gray = new Float32Array(sw * sh);
  for (let i = 0; i < sw * sh; i++) {
    gray[i] = 0.299 * data[i*4] + 0.587 * data[i*4+1] + 0.114 * data[i*4+2];
  }
  let sum = 0, sumSq = 0, count = 0;
  for (let y = 1; y < sh - 1; y++) {
    for (let x = 1; x < sw - 1; x++) {
      const idx = y * sw + x;
      const lap = -4 * gray[idx] + gray[idx-1] + gray[idx+1] + gray[idx-sw] + gray[idx+sw];
      sum += lap;
      sumSq += lap * lap;
      count++;
    }
  }
  if (count === 0) return 0;
  const mean = sum / count;
  return (sumSq / count) - (mean * mean);
};

const CONFIDENCE_THRESHOLD = 80;
const BURST_COUNT = 5;
const BURST_INTERVAL = 160; // ms between frames
const MIN_SHARPNESS = 20;   // if best frame is below this, show "too blurry"

export default function DeliveryCameraOverlay({
  show,
  videoRef,
  canvasRef,
  isScanning,
  error,
  onCapture,
  onClose,
  onPatientSelect,
  onCreatePatient,
  stores,
  appUser,
}) {
  const [cameraCount, setCameraCount] = useState(1);
  const [switching, setSwitching] = useState(false);
  const [scanState, setScanState] = useState('idle'); // idle | bursting | scanning | results | selected | error
  const [scanResults, setScanResults] = useState(null);
  const [blurWarning, setBlurWarning] = useState(false);
  const [burstProgress, setBurstProgress] = useState(0);

  const overlayActiveRef = useRef(false);
  const scanInProgressRef = useRef(false);

  // ── Barcode-triggered auto-capture ──
  const nativeDetectorRef = useRef(null);
  const barcodeLoopRef = useRef(null);
  const lastBarcodeAtRef = useRef(0);
  const lastBarcodeValueRef = useRef('');
  const [barcodeDetected, setBarcodeDetected] = useState(false);

  // Refs for interval-safe access
  const scanStateRef = useRef(scanState);
  scanStateRef.current = scanState;

  // ── Camera switching ──
  const handleSwitch = useCallback(async () => {
    if (switching || scanState === 'scanning' || scanState === 'bursting' || !videoRef.current) return;
    setSwitching(true);
    try {
      const result = await cycleRearCamera(videoRef.current);
      if (result?.stream && videoRef.current) {
        videoRef.current.srcObject = result.stream;
        try { await videoRef.current.play(); } catch {}
      }
      try { setCameraCount((await listCameras()).length); } catch {}
    } catch (e) {
      console.warn('[DeliveryCameraOverlay] Switch failed:', e?.message);
    } finally {
      setSwitching(false);
    }
  }, [switching, scanState, videoRef]);

  // ── Barcode-triggered fast capture: single frame, no sharpness gate ──
  const handleBarcodeCapture = useCallback(async () => {
    if (scanInProgressRef.current || !videoRef.current || !canvasRef.current) return;
    if (!overlayActiveRef.current) return;

    scanInProgressRef.current = true;
    setScanState('scanning');
    setBlurWarning(false);

    try {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      const ctx = canvas.getContext('2d');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.92));
      if (!blob) throw new Error('Failed to capture image');

      console.log('[DeliveryCameraOverlay] Barcode-triggered capture → LLM');
      const file = new File([blob], 'prescription_scan.jpg', { type: 'image/jpeg' });
      const result = await scanPrescriptionLabel({ file, mode: 'fileUrl', appUser });

      if (result.error) throw new Error(result.error);
      setScanResults(result);

      const allMatches = [...(result.exactMatches || []), ...(result.matches || [])];
      if (allMatches.length === 1 && allMatches[0].matchScore >= CONFIDENCE_THRESHOLD) {
        setScanState('selected');
        if (onPatientSelect) await onPatientSelect(allMatches[0].patient, allMatches[0].matchScore === 100);
        setTimeout(() => handleClose(), 600);
      } else {
        setScanState('results');
      }
    } catch (e) {
      console.error('[DeliveryCameraOverlay] Barcode scan failed:', e?.message);
      setScanState('error');
      setScanResults({ error: e?.message || 'Scan failed' });
      setTimeout(() => {
        if (overlayActiveRef.current) { setScanState('idle'); setScanResults(null); }
      }, 2500);
    } finally {
      scanInProgressRef.current = false;
    }
  }, [onPatientSelect, onClose]);

  const handleBarcodeCaptureRef = useRef(handleBarcodeCapture);
  handleBarcodeCaptureRef.current = handleBarcodeCapture;

  // ── Barcode detection loop ──
  const startBarcodeLoop = useCallback(() => {
    if (barcodeLoopRef.current) return;
    if (typeof window === 'undefined' || !('BarcodeDetector' in window)) {
      console.log('[DeliveryCameraOverlay] No BarcodeDetector — manual capture only');
      return;
    }
    try {
      nativeDetectorRef.current = new window.BarcodeDetector({
        formats: ['code_128', 'code_39', 'ean_13', 'ean_8', 'upc_a', 'upc_e']
      });
    } catch {
      console.warn('[DeliveryCameraOverlay] BarcodeDetector init failed');
      return;
    }
    let lastDetectAt = 0;
    barcodeLoopRef.current = setInterval(async () => {
      if (!overlayActiveRef.current || !videoRef.current || videoRef.current.readyState < 2) return;
      if (scanInProgressRef.current) return;
      const st = scanStateRef.current;
      if (st !== 'idle' && st !== 'error') return;

      const now = Date.now();
      if (now - lastDetectAt < 150) return;
      lastDetectAt = now;

      try {
        const barcodes = await nativeDetectorRef.current.detect(videoRef.current);
        if (barcodes?.length > 0) {
          const text = barcodes[0].rawValue || '';
          if (text && (text !== lastBarcodeValueRef.current || now - lastBarcodeAtRef.current > 800)) {
            lastBarcodeValueRef.current = text;
            lastBarcodeAtRef.current = now;
            setBarcodeDetected(true);
            console.log('[DeliveryCameraOverlay] Barcode:', text, '→ auto-capture');
            handleBarcodeCaptureRef.current();
          }
        } else {
          if (scanStateRef.current === 'idle') setBarcodeDetected(false);
        }
      } catch {}
    }, 120);
    console.log('[DeliveryCameraOverlay] Barcode auto-capture loop started');
  }, []);

  const stopBarcodeLoop = useCallback(() => {
    if (barcodeLoopRef.current) { clearInterval(barcodeLoopRef.current); barcodeLoopRef.current = null; }
    nativeDetectorRef.current = null;
    lastBarcodeValueRef.current = '';
    setBarcodeDetected(false);
  }, []);

  // ── iOS fallback: sharpness-based auto-capture timer ──
  // When BarcodeDetector is not available (iOS Safari), poll sharpness every 1.8s
  // and auto-fire burst capture if image is sharp enough (user has the label in frame).
  const iosAutoCaptureRef = useRef(null);
  const handleBurstCaptureRef = useRef(null);

  const startIosAutoCapture = useCallback(() => {
    if (typeof window !== 'undefined' && 'BarcodeDetector' in window) return; // Android handles via BarcodeDetector
    if (iosAutoCaptureRef.current) return;
    const IOS_SHARPNESS_THRESHOLD = 18; // minimum sharpness to trigger auto-capture
    const IOS_POLL_INTERVAL = 1800;     // ms between auto-capture checks

    iosAutoCaptureRef.current = setInterval(() => {
      if (!overlayActiveRef.current || !videoRef.current || !canvasRef.current) return;
      if (scanInProgressRef.current) return;
      const st = scanStateRef.current;
      if (st !== 'idle') return;
      if (!videoRef.current.videoWidth || !videoRef.current.videoHeight) return;

      // Quick sharpness check using a small canvas
      const tempCanvas = document.createElement('canvas');
      const tempCtx = tempCanvas.getContext('2d');
      tempCanvas.width = videoRef.current.videoWidth;
      tempCanvas.height = videoRef.current.videoHeight;
      tempCtx.drawImage(videoRef.current, 0, 0, tempCanvas.width, tempCanvas.height);
      const sharpness = calculateSharpness(tempCanvas, tempCtx);

      if (sharpness >= IOS_SHARPNESS_THRESHOLD) {
        console.log('[DeliveryCameraOverlay] iOS auto-capture triggered, sharpness:', sharpness.toFixed(1));
        if (handleBurstCaptureRef.current) handleBurstCaptureRef.current();
      }
    }, IOS_POLL_INTERVAL);
    console.log('[DeliveryCameraOverlay] iOS sharpness auto-capture loop started');
  }, []);

  const stopIosAutoCapture = useCallback(() => {
    if (iosAutoCaptureRef.current) { clearInterval(iosAutoCaptureRef.current); iosAutoCaptureRef.current = null; }
  }, []);

  // ── Burst capture: grab N frames, pick the sharpest (manual fallback) ──
  const handleBurstCapture = useCallback(async () => {
    if (scanInProgressRef.current || !videoRef.current || !canvasRef.current) return;
    if (scanState === 'scanning' || scanState === 'bursting') return;

    scanInProgressRef.current = true;
    setScanState('bursting');
    setBlurWarning(false);
    setBurstProgress(0);

    const video = videoRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');

    // Use a temp canvas for sharpness checks (small, fast)
    const tempCanvas = document.createElement('canvas');
    const tempCtx = tempCanvas.getContext('2d');

    let bestSharpness = -1;
    let bestBlob = null;
    let bestSharpThumb = null; // for debugging

    for (let i = 0; i < BURST_COUNT; i++) {
      if (!overlayActiveRef.current) break;

      // Wait for next frame if possible
      if (i > 0) await new Promise(r => setTimeout(r, BURST_INTERVAL));

      if (!video.videoWidth || !video.videoHeight) continue;

      // Draw to temp canvas for sharpness check
      tempCanvas.width = video.videoWidth;
      tempCanvas.height = video.videoHeight;
      tempCtx.drawImage(video, 0, 0, tempCanvas.width, tempCanvas.height);

      const sharpness = calculateSharpness(tempCanvas, tempCtx);
      console.log(`[burst] frame ${i}: sharpness=${sharpness.toFixed(1)}`);

      // Draw to main canvas and convert to blob
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.92));
      if (!blob) continue;

      if (sharpness > bestSharpness) {
        bestSharpness = sharpness;
        bestBlob = blob;
      }

      setBurstProgress(((i + 1) / BURST_COUNT) * 100);
    }

    if (!bestBlob) {
      setScanState('error');
      setScanResults({ error: 'Failed to capture image' });
      scanInProgressRef.current = false;
      return;
    }

    // If the best frame is still too blurry, show warning and return to idle
    if (bestSharpness < MIN_SHARPNESS) {
      console.warn(`[burst] Best sharpness ${bestSharpness.toFixed(1)} below threshold ${MIN_SHARPNESS}`);
      setScanState('idle');
      setBlurWarning(true);
      scanInProgressRef.current = false;
      // Clear blur warning after 3s
      setTimeout(() => { if (overlayActiveRef.current) setBlurWarning(false); }, 3000);
      return;
    }

    // Send the sharpest frame to the LLM
    setScanState('scanning');
    try {
      const file = new File([bestBlob], 'prescription_scan.jpg', { type: 'image/jpeg' });
      const result = await scanPrescriptionLabel({ file, mode: 'fileUrl', appUser });

      if (result.error) throw new Error(result.error);

      setScanResults(result);

      const allMatches = [
        ...(result.exactMatches || []),
        ...(result.matches || [])
      ];

      if (allMatches.length === 1 && allMatches[0].matchScore >= CONFIDENCE_THRESHOLD) {
        setScanState('selected');
        if (onPatientSelect) {
          await onPatientSelect(allMatches[0].patient, allMatches[0].matchScore === 100);
        }
        setTimeout(() => handleClose(), 600);
      } else {
        setScanState('results');
      }
    } catch (e) {
      console.error('[DeliveryCameraOverlay] Scan failed:', e?.message);
      setScanState('error');
      setScanResults({ error: e?.message || 'Scan failed' });
      setTimeout(() => {
        if (overlayActiveRef.current) {
          setScanState('idle');
          setScanResults(null);
        }
      }, 2500);
    } finally {
      scanInProgressRef.current = false;
    }
  }, [scanState, onPatientSelect, onClose]);

  // Keep iOS auto-capture ref in sync with latest handleBurstCapture
  handleBurstCaptureRef.current = handleBurstCapture;

  // ── Patient selection from results ──
  const handleSelectPatient = useCallback(async (patient) => {
    setScanState('selected');
    if (onPatientSelect) await onPatientSelect(patient, false);
    setTimeout(() => handleClose(), 400);
  }, [onPatientSelect]);

  // ── Create new patient ──
  const handleCreateNew = useCallback(() => {
    if (!scanResults?.extractedData || !onCreatePatient) return;
    const ed = scanResults.extractedData;
    onCreatePatient(() => handleClose(), {
      full_name: ed.patient_name,
      address: ed.street_address,
      phone: ed.phone_number,
      _isNew: true
    });
  }, [scanResults, onCreatePatient]);

  // ── Close ──
  const handleClose = useCallback(() => {
    overlayActiveRef.current = false;
    setScanState('idle');
    setScanResults(null);
    setBlurWarning(false);
    onClose();
  }, [onClose]);

  // ── Retake ──
  const handleRetake = useCallback(() => {
    setScanState('idle');
    setScanResults(null);
    setBlurWarning(false);
    lastBarcodeValueRef.current = '';
  }, []);

  // ── Reset state when overlay opens; hide GuideAssistant while open ──
  useEffect(() => {
    if (!show) {
      overlayActiveRef.current = false;
      stopBarcodeLoop();
      stopIosAutoCapture();
      window.dispatchEvent(new CustomEvent('cameraOverlayChange', { detail: { open: false } }));
      return;
    }
    overlayActiveRef.current = true;
    setScanState('idle');
    setScanResults(null);
    setBlurWarning(false);
    listCameras().then(cams => setCameraCount(cams.length)).catch(() => {});
    window.dispatchEvent(new CustomEvent('cameraOverlayChange', { detail: { open: true } }));
    setTimeout(() => { startBarcodeLoop(); startIosAutoCapture(); }, 1200);
  }, [show, startBarcodeLoop, stopBarcodeLoop, startIosAutoCapture, stopIosAutoCapture]);

  if (!show) return null;

  const showCaptureButton = scanState === 'idle' || scanState === 'error';

  return createPortal(
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[10030] bg-black flex flex-col items-center justify-between"
        style={{ paddingTop: "env(safe-area-inset-top, 12px)", paddingBottom: "0px" }}
      >
        {/* ── Top: viewfinder + status hint + results ── */}
        <div className="w-full max-w-lg flex flex-col items-center px-2 pt-2 gap-2">
          {/* Viewfinder */}
          <div className="relative w-full" style={{ aspectRatio: '16 / 8' }}>
            <div className={`relative w-full h-full rounded-lg overflow-hidden border-2 transition-colors duration-200 ${
              scanState === 'selected' ? 'border-emerald-400' :
              scanState === 'scanning' ? 'border-blue-400' :
              scanState === 'bursting' ? 'border-amber-400' :
              blurWarning ? 'border-red-400/60' :
              'border-white/30'
            }`}>
              <video ref={videoRef} autoPlay playsInline muted className="absolute inset-0 w-full h-full object-cover" style={{ objectPosition: "center" }} />
              <canvas ref={canvasRef} style={{ display: 'none' }} />

              {/* Burst progress bar */}
              {scanState === 'bursting' && (
                <div className="absolute top-0 left-0 right-0 h-1 bg-black/40">
                  <div className="h-full bg-amber-400 transition-all duration-100" style={{ width: `${burstProgress}%` }} />
                </div>
              )}

              {/* Scanning overlay */}
              {scanState === 'scanning' && (
                <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                  <div className="flex flex-col items-center gap-2">
                    <div className="animate-spin w-8 h-8 border-3 border-white border-t-transparent rounded-full" />
                    <div className="text-white text-sm">Extracting...</div>
                  </div>
                </div>
              )}

              {/* Selected flash */}
              {scanState === 'selected' && (
                <div className="absolute inset-0 bg-emerald-500/30 flex items-center justify-center">
                  <div className="flex items-center gap-2 text-white text-lg font-semibold">
                    <Check className="w-7 h-7" /> Matched
                  </div>
                </div>
              )}

              {/* Blur warning flash */}
              {blurWarning && scanState === 'idle' && (
                <div className="absolute inset-0 bg-red-500/20 flex items-center justify-center">
                  <div className="flex items-center gap-2 text-white text-base font-medium">
                    <AlertCircle className="w-6 h-6" /> Too blurry
                  </div>
                </div>
              )}

              {/* Corner brackets — turn green when barcode detected */}
              {scanState === 'idle' && !blurWarning && (
                <>
                  <div className={`absolute top-3 left-3 w-6 h-6 border-t-2 border-l-2 rounded-tl transition-colors duration-200 ${barcodeDetected ? 'border-emerald-400' : 'border-white/40'}`} />
                  <div className={`absolute top-3 right-3 w-6 h-6 border-t-2 border-r-2 rounded-tr transition-colors duration-200 ${barcodeDetected ? 'border-emerald-400' : 'border-white/40'}`} />
                  <div className={`absolute bottom-3 left-3 w-6 h-6 border-b-2 border-l-2 rounded-bl transition-colors duration-200 ${barcodeDetected ? 'border-emerald-400' : 'border-white/40'}`} />
                  <div className={`absolute bottom-3 right-3 w-6 h-6 border-b-2 border-r-2 rounded-br transition-colors duration-200 ${barcodeDetected ? 'border-emerald-400' : 'border-white/40'}`} />
                </>
              )}
              {/* Barcode detected badge */}
              {barcodeDetected && scanState === 'idle' && (
                <div className="absolute top-2 left-1/2 -translate-x-1/2 flex items-center gap-1.5 bg-emerald-500/30 backdrop-blur-sm px-3 py-1 rounded-full">
                  <ScanLine className="w-4 h-4 text-emerald-300" />
                  <span className="text-emerald-200 text-xs font-medium">Barcode found</span>
                </div>
              )}
            </div>
          </div>

          {/* Status hint — centered white text below viewfinder */}
          <div className="text-white text-sm font-medium text-center px-4">
            {scanState === 'bursting' ? `Capturing... ${Math.round(burstProgress)}%` :
             scanState === 'scanning' ? 'Scanning label...' :
             scanState === 'results' ? 'Select patient' :
             scanState === 'selected' ? '\u2713 Patient selected' :
             scanState === 'error' ? 'Scan failed' :
             blurWarning ? 'Too blurry — try again' :
             barcodeDetected ? 'Barcode detected — capturing...' :
             ('BarcodeDetector' in window ? 'Point at a prescription label and click' : 'Point at label — auto-captures when sharp')}
          </div>

          {/* Results panel (scrollable if needed) */}
          {scanState === 'error' && scanResults?.error && (
            <div className="flex items-center gap-2 p-3 bg-red-500/20 border border-red-500/40 rounded-lg text-white text-sm w-full">
              <AlertCircle className="w-5 h-5 flex-shrink-0" />
              {scanResults.error}
            </div>
          )}

          {scanState === 'results' && scanResults && !scanResults.error && (
            <ResultsPanel
              scanResults={scanResults}
              stores={stores}
              onSelectPatient={handleSelectPatient}
              onCreateNew={handleCreateNew}
              onRetake={handleRetake}
            />
          )}
        </div>

        {/* ── Bottom: action bar pinned to bottom of screen ── */}
        <div className="w-full max-w-lg flex items-center justify-between px-6" style={{ paddingBottom: "max(24px, env(safe-area-inset-bottom, 24px))" }}>
          {/* Left: switch camera — always visible, same size/shape as capture */}
          <button
            type="button"
            onClick={handleSwitch}
            disabled={switching || scanState === 'scanning' || scanState === 'bursting'}
            className="flex items-center justify-center rounded-full bg-white/20 backdrop-blur-sm w-16 h-16 text-white transition active:scale-95 disabled:opacity-50 touch-manipulation"
            style={{ WebkitTapHighlightColor: 'transparent' }}
          >
            {switching
              ? <div className="animate-spin w-6 h-6 border-2 border-white border-t-transparent rounded-full" />
              : <SwitchCamera className="w-7 h-7" />}
          </button>

          {/* Center: capture */}
          {showCaptureButton ? (
            <button
              type="button"
              onClick={handleBurstCapture}
              disabled={switching}
              className="flex items-center justify-center rounded-full bg-white text-black w-16 h-16 shadow-lg transition active:scale-95 disabled:opacity-50 touch-manipulation"
              style={{ WebkitTapHighlightColor: 'transparent' }}
            >
              <Camera className="w-7 h-7" />
            </button>
          ) : <div className="w-16 h-16" />}

          {/* Right: close — same size/shape as capture */}
          <button
            type="button"
            onClick={handleClose}
            className="flex items-center justify-center rounded-full bg-white/20 backdrop-blur-sm w-16 h-16 text-white transition active:scale-95 touch-manipulation"
            style={{ WebkitTapHighlightColor: 'transparent' }}
          >
            <X className="w-7 h-7" />
          </button>
        </div>
      </motion.div>
    </AnimatePresence>
  , document.body);
}

// ── Results panel ──
function ResultsPanel({ scanResults, stores, onSelectPatient, onCreateNew, onRetake }) {
  const { extractedData, exactMatches = [], matches = [] } = scanResults;
  const allMatches = [...exactMatches, ...matches];

  return (
    <div className="space-y-3">
      {extractedData && (
        <div className="p-3 bg-white/10 rounded-lg border border-white/15">
          <div className="text-white/50 text-xs font-medium mb-1.5 uppercase tracking-wide">Scanned Label</div>
          <div className="space-y-1 text-white text-sm">
            {extractedData.patient_name && (
              <div className="flex items-center gap-2">
                <User className="w-3.5 h-3.5 text-white/40" />
                {extractedData.patient_name}
              </div>
            )}
            {extractedData.phone_number && (
              <div className="flex items-center gap-2">
                <Phone className="w-3.5 h-3.5 text-white/40" />
                {formatPhoneNumber(extractedData.phone_number)}
              </div>
            )}
            {extractedData.street_address && (
              <div className="flex items-center gap-2">
                <MapPin className="w-3.5 h-3.5 text-white/40" />
                {extractedData.street_address}
              </div>
            )}
          </div>
        </div>
      )}

      {allMatches.length > 0 ? (
        <>
          {allMatches.length === 1 && allMatches[0].matchScore < CONFIDENCE_THRESHOLD && (
            <div className="flex items-center gap-2 text-amber-300 text-sm px-1">
              <AlertCircle className="w-4 h-4" />
              Low confidence ({allMatches[0].matchScore}%). Confirm or create new.
            </div>
          )}
          {allMatches.length > 1 && (
            <div className="text-white/60 text-sm px-1">
              {allMatches.length} potential matches:
            </div>
          )}
          <div className="space-y-2">
            {allMatches.map((match, i) => {
              const score = match.matchScore || match.score || 0;
              const isExact = score >= 100;
              const isHigh = score >= CONFIDENCE_THRESHOLD;
              return (
                <button
                  key={match.patient.id || i}
                  type="button"
                  onClick={() => onSelectPatient(match.patient)}
                  className="w-full text-left p-3 rounded-lg bg-white/10 hover:bg-white/15 border border-white/15 hover:border-white/30 transition touch-manipulation"
                  style={{ WebkitTapHighlightColor: 'transparent' }}
                >
                  <div className="flex items-start justify-between mb-1.5">
                    <div className="font-medium text-white text-sm">{match.patient.full_name}</div>
                    <div className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                      isExact ? 'bg-emerald-500/30 text-emerald-200' :
                      isHigh ? 'bg-blue-500/30 text-blue-200' :
                      'bg-amber-500/30 text-amber-200'
                    }`}>
                      {score}%
                    </div>
                  </div>
                  <div className="space-y-0.5 text-white/60 text-xs">
                    {match.patient.phone && (
                      <div className="flex items-center gap-1.5">
                        <Phone className="w-3 h-3" />
                        {formatPhoneNumber(match.patient.phone)}
                      </div>
                    )}
                    {match.patient.address && (
                      <div className="flex items-center gap-1.5">
                        <MapPin className="w-3 h-3" />
                        {match.patient.address}
                      </div>
                    )}
                    {stores && match.patient.store_id && (() => {
                      const s = stores.find(s => s?.id === match.patient.store_id);
                      return s ? <div className="text-white/40">{s.name}</div> : null;
                    })()}
                  </div>
                </button>
              );
            })}
          </div>
        </>
      ) : (
        <div className="text-white/70 text-sm px-1">No matching patients found.</div>
      )}

      {extractedData?.patient_name && onCreateNew && (
        <button
          type="button"
          onClick={onCreateNew}
          className="w-full p-3 rounded-lg bg-blue-500/20 hover:bg-blue-500/30 border border-blue-400/30 text-blue-200 text-sm font-medium transition flex items-center justify-center gap-2 touch-manipulation"
          style={{ WebkitTapHighlightColor: 'transparent' }}
        >
          <User className="w-4 h-4" />
          Create New Patient
        </button>
      )}

      <button
        type="button"
        onClick={onRetake}
        className="w-full p-2.5 rounded-lg bg-white/10 hover:bg-white/15 text-white/70 text-sm transition flex items-center justify-center gap-2 touch-manipulation"
        style={{ WebkitTapHighlightColor: 'transparent' }}
      >
        <Camera className="w-4 h-4" />
        Scan Again
      </button>
    </div>
  );
}