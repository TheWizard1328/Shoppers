import React, { useState, useCallback, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Camera, SwitchCamera, X, Check, User, Phone, MapPin, AlertCircle } from "lucide-react";
import { listCameras, cycleRearCamera, getSavedCameraId } from "./useDeliveryCamera";
import { scanPrescriptionLabel } from "./prescriptionScanHelpers";
import { formatPhoneNumber } from "../utils/phoneFormatter";

// Laplacian sharpness check — returns variance of Laplacian kernel
// High variance = sharp/in-focus, low = blurry
const calculateSharpness = (canvas, ctx) => {
  const w = canvas.width;
  const h = canvas.height;
  // Downscale for speed — only need to detect blur, not full resolution
  const scale = Math.min(1, 240 / Math.max(w, h));
  const sw = Math.round(w * scale);
  const sh = Math.round(h * scale);
  const imageData = ctx.getImageData(0, 0, sw, sh > 0 ? sh : 1);
  const data = imageData.data;
  const gray = new Float32Array(sw * sh);
  for (let i = 0; i < sw * sh; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }
  // Laplacian: [0,1,0; 1,-4,1; 0,1,0]
  let sum = 0, sumSq = 0, count = 0;
  for (let y = 1; y < sh - 1; y++) {
    for (let x = 1; x < sw - 1; x++) {
      const idx = y * sw + x;
      const lap = -4 * gray[idx] + gray[idx - 1] + gray[idx + 1] + gray[idx - sw] + gray[idx + sw];
      sum += lap;
      sumSq += lap * lap;
      count++;
    }
  }
  if (count === 0) return 0;
  const mean = sum / count;
  const variance = (sumSq / count) - (mean * mean);
  return variance;
};

const CONFIDENCE_THRESHOLD = 80;
const SHARPNESS_THRESHOLD = 80; // Empirically tuned
const AUTO_CAPTURE_COOLDOWN = 2500; // ms between auto-captures

export default function DeliveryCameraOverlay({
  show,
  videoRef,
  canvasRef,
  isScanning,
  error,
  onCapture,        // legacy manual capture callback (unused in auto mode)
  onClose,
  // New props for inline results
  onPatientSelect,  // (patient, isExact) => void
  onCreatePatient,  // (callback, patientData) => void
  stores,
}) {
  const [cameraCount, setCameraCount] = useState(1);
  const [switching, setSwitching] = useState(false);
  const [scanState, setScanState] = useState('idle'); // idle | scanning | results
  const [scanResults, setScanResults] = useState(null); // { extractedData, exactMatches, matches }
  const [sharpHint, setSharpHint] = useState(''); // "Hold steady..." | "Sharp!" | ""
  const [lastCaptureTime, setLastCaptureTime] = useState(0);

  const autoCaptureRef = useRef(true);
  const sharpCheckTimerRef = useRef(null);
  const scanInProgressRef = useRef(false);
  const overlayActiveRef = useRef(false);

  // ── Camera switching ──
  const handleSwitch = useCallback(async () => {
    if (switching || scanState === 'scanning' || !videoRef.current) return;
    setSwitching(true);
    try {
      const result = await cycleRearCamera(videoRef.current);
      if (result?.stream && videoRef.current) {
        videoRef.current.srcObject = result.stream;
        try { await videoRef.current.play(); } catch {}
      }
      try {
        const cams = await listCameras();
        setCameraCount(cams.length);
      } catch {}
    } catch (e) {
      console.warn('[DeliveryCameraOverlay] Switch failed:', e?.message);
    } finally {
      setSwitching(false);
    }
  }, [switching, scanState, videoRef]);

  // ── Auto-capture loop ──
  // Every 400ms, grab a frame, check sharpness. If sharp enough and cooldown elapsed, auto-capture.
  useEffect(() => {
    if (!show) {
      overlayActiveRef.current = false;
      if (sharpCheckTimerRef.current) {
        clearInterval(sharpCheckTimerRef.current);
        sharpCheckTimerRef.current = null;
      }
      return;
    }
    overlayActiveRef.current = true;
    setScanState('idle');
    setScanResults(null);

    listCameras().then(cams => setCameraCount(cams.length)).catch(() => {});

    // Start sharpness polling
    sharpCheckTimerRef.current = setInterval(async () => {
      if (!overlayActiveRef.current || !videoRef.current || !canvasRef.current) return;
      if (scanState === 'scanning' || scanState === 'results') return;
      if (scanInProgressRef.current) return;
      if (switching) return;

      const video = videoRef.current;
      if (!video.videoWidth || !video.videoHeight) return;

      const canvas = canvasRef.current;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      const sharpness = calculateSharpness(canvas, ctx);

      if (sharpness >= SHARPNESS_THRESHOLD) {
        setSharpHint('Sharp!');
        // Auto-capture if cooldown elapsed
        const now = Date.now();
        if (now - lastCaptureTime > AUTO_CAPTURE_COOLDOWN && autoCaptureRef.current) {
          autoCaptureRef.current = false;
          setLastCaptureTime(now);
          triggerScan();
        }
      } else if (sharpness > SHARPNESS_THRESHOLD * 0.4) {
        setSharpHint('Hold steady...');
      } else {
        setSharpHint('');
      }
    }, 400);

    return () => {
      overlayActiveRef.current = false;
      if (sharpCheckTimerRef.current) {
        clearInterval(sharpCheckTimerRef.current);
        sharpCheckTimerRef.current = null;
      }
    };
  }, [show, scanState, switching, lastCaptureTime]);

  // ── Trigger a scan from the current video frame ──
  const triggerScan = useCallback(async () => {
    if (scanInProgressRef.current || !videoRef.current || !canvasRef.current) return;
    scanInProgressRef.current = true;
    setScanState('scanning');
    setSharpHint('');

    try {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      // Create a file from the canvas
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.92));
      if (!blob) throw new Error('Failed to capture image');
      const file = new File([blob], 'prescription_scan.jpg', { type: 'image/jpeg' });

      const result = await scanPrescriptionLabel({ file, mode: 'fileUrl' });

      if (result.error) throw new Error(result.error);

      setScanResults(result);

      // If exactly one 80%+ match, auto-select and close
      const allMatches = [
        ...(result.exactMatches || []),
        ...(result.matches || [])
      ];

      if (allMatches.length === 1 && allMatches[0].matchScore >= CONFIDENCE_THRESHOLD) {
        // Auto-select the single high-confidence match
        setScanState('selected');
        if (onPatientSelect) {
          await onPatientSelect(allMatches[0].patient, allMatches[0].matchScore === 100);
        }
        // Close after a brief confirmation flash
        setTimeout(() => {
          handleClose();
        }, 600);
      } else if (allMatches.length > 0) {
        // Multiple matches or low confidence — show results panel
        setScanState('results');
      } else {
        // No matches — show extracted data with option to create patient
        setScanState('results');
      }
    } catch (e) {
      console.error('[DeliveryCameraOverlay] Auto-scan failed:', e?.message);
      setScanState('error');
      setScanResults({ error: e?.message || 'Scan failed' });
      // Reset to idle after 2s so user can retry
      setTimeout(() => {
        if (overlayActiveRef.current) {
          setScanState('idle');
          setScanResults(null);
          autoCaptureRef.current = true;
        }
      }, 2500);
    } finally {
      scanInProgressRef.current = false;
    }
  }, [onPatientSelect, onClose]);

  // ── Handle selecting a patient from results ──
  const handleSelectPatient = useCallback(async (patient) => {
    setScanState('selected');
    if (onPatientSelect) {
      await onPatientSelect(patient, false);
    }
    setTimeout(() => handleClose(), 400);
  }, [onPatientSelect]);

  // ── Handle creating a new patient from extracted data ──
  const handleCreateNew = useCallback(() => {
    if (!scanResults?.extractedData || !onCreatePatient) return;
    const ed = scanResults.extractedData;
    onCreatePatient((createdPatient) => {
      handleClose();
    }, {
      full_name: ed.patient_name,
      address: ed.street_address,
      phone: ed.phone_number,
      _isNew: true
    });
  }, [scanResults, onCreatePatient]);

  // ── Close ──
  const handleClose = useCallback(() => {
    overlayActiveRef.current = false;
    if (sharpCheckTimerRef.current) {
      clearInterval(sharpCheckTimerRef.current);
      sharpCheckTimerRef.current = null;
    }
    setScanState('idle');
    setScanResults(null);
    setSharpHint('');
    autoCaptureRef.current = true;
    onClose();
  }, [onClose]);

  // ── Retake / re-scan ──
  const handleRetake = useCallback(() => {
    setScanState('idle');
    setScanResults(null);
    autoCaptureRef.current = true;
    setLastCaptureTime(0); // allow immediate re-capture
  }, []);

  if (!show) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[10030] bg-black flex flex-col items-center justify-start p-2 pt-3"
      >
        {/* Top bar: close button */}
        <div className="w-full max-w-lg flex items-center justify-between mb-2">
          <div className="text-white/90 text-sm font-medium px-2">
            {scanState === 'scanning' ? 'Scanning label...' :
             scanState === 'results' ? 'Select patient' :
             scanState === 'selected' ? '✓ Patient selected' :
             scanState === 'error' ? 'Scan failed — retrying' :
             'Point at a prescription label'}
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="flex items-center justify-center rounded-full bg-white/15 backdrop-blur-sm w-9 h-9 text-white transition active:bg-white/30 touch-manipulation"
            style={{ WebkitTapHighlightColor: 'transparent' }}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Viewfinder — wide landscape, same width as stop cards */}
        <div className="relative w-full max-w-lg" style={{ aspectRatio: '16 / 7' }}>
          <div className={`relative w-full h-full rounded-lg overflow-hidden border-2 ${
            scanState === 'selected' ? 'border-emerald-400' :
            scanState === 'scanning' ? 'border-blue-400' :
            sharpHint === 'Sharp!' ? 'border-emerald-400/60' :
            'border-white/30'
          }`}>
            <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" />

            {/* Scanning overlay */}
            {scanState === 'scanning' && (
              <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                <div className="flex flex-col items-center gap-2">
                  <div className="animate-spin w-8 h-8 border-3 border-white border-t-transparent rounded-full" />
                  <div className="text-white text-sm">Extracting...</div>
                </div>
              </div>
            )}

            {/* Selected confirmation flash */}
            {scanState === 'selected' && (
              <div className="absolute inset-0 bg-emerald-500/30 flex items-center justify-center">
                <div className="flex items-center gap-2 text-white text-lg font-semibold">
                  <Check className="w-7 h-7" /> Matched
                </div>
              </div>
            )}

            {/* Sharpness hint badge — bottom left */}
            {scanState === 'idle' && sharpHint && (
              <div className={`absolute bottom-2 left-2 px-2.5 py-1 rounded-full text-xs font-medium ${
                sharpHint === 'Sharp!' ? 'bg-emerald-500/70 text-white' : 'bg-white/20 text-white/80'
              }`}>
                {sharpHint === 'Sharp!' ? '✓ ' : ''}{sharpHint}
              </div>
            )}

            {/* Switch camera button — bottom right of viewfinder */}
            {cameraCount > 1 && scanState !== 'scanning' && (
              <button
                type="button"
                onClick={handleSwitch}
                disabled={switching || scanState === 'scanning'}
                className="absolute bottom-2 right-2 z-10 flex items-center justify-center rounded-full bg-white/25 backdrop-blur-sm w-11 h-11 text-white transition active:bg-white/40 disabled:opacity-50 touch-manipulation"
                title="Switch camera lens"
                style={{ WebkitTapHighlightColor: 'transparent' }}
              >
                {switching
                  ? <div className="animate-spin w-5 h-5 border-2 border-white border-t-transparent rounded-full" />
                  : <SwitchCamera className="w-5 h-5" />}
              </button>
            )}

            {/* Scanning frame guide — subtle corner brackets */}
            {scanState === 'idle' && (
              <>
                <div className="absolute top-3 left-3 w-6 h-6 border-t-2 border-l-2 border-white/40 rounded-tl" />
                <div className="absolute top-3 right-3 w-6 h-6 border-t-2 border-r-2 border-white/40 rounded-tr" />
                <div className="absolute bottom-3 left-3 w-6 h-6 border-b-2 border-l-2 border-white/40 rounded-bl" />
                <div className="absolute bottom-3 right-3 w-6 h-6 border-b-2 border-r-2 border-white/40 rounded-br" />
              </>
            )}
          </div>
        </div>

        {/* Results panel — below the viewfinder */}
        <div className="w-full max-w-lg flex-1 overflow-y-auto mt-2">
          <canvas ref={canvasRef} style={{ display: 'none' }} />

          {scanState === 'error' && scanResults?.error && (
            <div className="flex items-center gap-2 p-3 bg-red-500/20 border border-red-500/40 rounded-lg text-white text-sm">
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
      </motion.div>
    </AnimatePresence>
  );
}

// ── Inline results panel ──
function ResultsPanel({ scanResults, stores, onSelectPatient, onCreateNew, onRetake }) {
  const { extractedData, exactMatches = [], matches = [] } = scanResults;
  const allMatches = [...exactMatches, ...matches];

  return (
    <div className="space-y-3">
      {/* Extracted data summary */}
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

      {/* Match candidates */}
      {allMatches.length > 0 ? (
        <>
          {allMatches.length === 1 && allMatches[0].matchScore < CONFIDENCE_THRESHOLD && (
            <div className="flex items-center gap-2 text-amber-300 text-sm px-1">
              <AlertCircle className="w-4 h-4" />
              Low confidence match ({allMatches[0].matchScore}%). Confirm or create new.
            </div>
          )}
          {allMatches.length > 1 && (
            <div className="text-white/60 text-sm px-1">
              {allMatches.length} potential matches found:
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
                    <div className="font-medium text-white text-sm">
                      {match.patient.full_name}
                    </div>
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
                      return s ? (
                        <div className="text-white/40">{s.name}</div>
                      ) : null;
                    })()}
                  </div>
                </button>
              );
            })}
          </div>
        </>
      ) : (
        <div className="text-white/50 text-sm px-1">
          No matching patients found.
        </div>
      )}

      {/* Create new patient button */}
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

      {/* Retake button */}
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
