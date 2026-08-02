import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useDevice } from '@/components/utils/DeviceContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Camera, Barcode, Minus, Sun, ZoomIn, X, SwitchCamera, Check } from 'lucide-react';
import { BrowserMultiFormatReader } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType } from '@zxing/library';

import BarcodeThumb from './BarcodeThumb';
import { openStream, cycleRearCamera, getSavedCameraId, listCameras, getCachedStream, isStreamAlive, detachStream } from './useDeliveryCamera';
import LargeBarcodePreview from './LargeBarcodePreview';

const classifyBarcode = (value) => {
  const raw = String(value || '').trim();
  const normalized = raw.replace(/\s+/g, '');
  const compact = normalized.replace(/^RX[#:\-]*/i, '');

  if (!compact) return 'receipt';
  // Explicit RX prefix = always rx
  if (/^rx[#:\-\s]*/i.test(raw)) return 'rx';

  // Pure numeric barcodes (most common from physical barcode scanners)
  if (/^\d+$/.test(compact)) {
    // Shoppers Drug Mart / pharmacy receipt barcodes are typically 13-18 digits (UPC/EAN)
    // Rx prescription barcodes are typically 20+ digits or start with 96
    if (/^96/.test(compact) && compact.length >= 30) return 'rx';
    if (/^99/.test(compact) && compact.length >= 20 && compact.length < 30) return 'receipt';
    // 8-13 digits = UPC/EAN = receipt barcode
    if (compact.length >= 8 && compact.length <= 13) return 'receipt';
    // 14-19 digits = could be either, default to receipt (shipping/tracking)
    if (compact.length >= 14 && compact.length <= 19) return 'receipt';
    // 20+ digits = rx barcode
    if (compact.length >= 20) return 'rx';
    // 4-7 digits = short code, likely rx
    if (compact.length >= 4) return 'rx';
  }

  // Alphanumeric with no separators — likely rx prescription number
  if (/^[A-Za-z]{0,3}\d{4,12}$/.test(compact) && !/[-/.]/.test(compact)) return 'rx';
  if (/^[A-Za-z0-9]{4,12}$/.test(compact) && !/[\-/.]/.test(compact)) return 'rx';
  return 'receipt';
};

function BarcodeColumn({ title, values, onRemove, onSelectBarcode, countColor, singleVisible = false, isRx = false }) {
  return (
    <div className="bg-card my-1.5 p-2 rounded-md space-y-2 border border-border dark:bg-slate-900/40 dark:border-slate-700">
      <div className="flex items-center justify-between">
        <Label className="text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</Label>
        {values.length > 0 &&
        <Badge className={`text-xs px-1.5 py-0 h-5 ${countColor}`}>{values.length}</Badge>
        }
      </div>
      {values.length > 0 ?
      <div className="flex justify-center">
          <div
          className={`${values.length >= 2 ? 'w-[244px]' : 'w-[120px]'} max-w-full overflow-x-auto custom-scrollbar pb-1 scroll-smooth ${singleVisible ? 'snap-x snap-mandatory snap-center' : ''}`}
          style={{ scrollbarWidth: 'thin' }}
          onWheel={(e) => {
            if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
              e.preventDefault();
              e.currentTarget.scrollLeft += e.deltaY;
            }
          }}>
          
            <div className={`flex gap-1 ${singleVisible ? 'w-max px-[74px]' : values.length === 1 ? 'justify-center' : 'w-max'}`}>
              {values.map((val, idx) =>
            <div
              key={`${title}-${idx}-${val}`} className={`relative w-[95px] flex-shrink-0 rounded-lg border bg-white dark:bg-slate-800 p-1 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-700 ${singleVisible ? 'snap-center' : ''}`}
              style={{ scrollSnapStop: singleVisible ? 'always' : 'normal' }}

              onClick={() => onSelectBarcode(val)}
              title={val}>
              <BarcodeThumb value={val} isRx={isRx} />
              <button
                type="button"
                className="absolute -top-1 -right-1 h-5 w-5 min-h-5 min-w-5 rounded-full bg-red-600 text-white flex items-center justify-center p-0 leading-none"
                onClick={(e) => {e.stopPropagation();onRemove(idx);}}
                aria-label="Remove barcode">
                <X className="w-3 h-3" />
              </button>
            </div>
            )}
            </div>
          </div>
        </div> :

      <div className="h-[52px] rounded-md border border-dashed border-border flex items-center justify-center text-xs text-muted-foreground">
          No barcodes yet
        </div>
      }
    </div>);

}

export default function SmartBarcodeScanner({
  receiptBarcodeValues = [],
  rxBarcodeValues = [],
  onReceiptChange,
  onRxChange,
  disabled = false,
  onSelectBarcode = () => {},
  manualInputOverride = '',
  focusTrigger = 0,
  onManualInputOverrideApplied = () => {},
  barcodeInputRef: externalBarcodeInputRef = null,
}) {
  const [manualInput, setManualInput] = useState('');
  const [showCamera, setShowCamera] = useState(false);
  const [selectedBarcode, setSelectedBarcode] = useState(null);
  const [isStartingCamera, setIsStartingCamera] = useState(false);
  const [flashHit, setFlashHit] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [canZoom, setCanZoom] = useState(false);
  const [hasTorch, setHasTorch] = useState(false);
  const [torchOn, setTorchOn] = useState(false);

  const internalInputRef = useRef(null);
  const inputRef = internalInputRef;
  // Refs to track latest barcode arrays — prevents stale closure in camera scan loop
  const receiptBarcodesRef = useRef(receiptBarcodeValues);
  const rxBarcodesRef = useRef(rxBarcodeValues);
  receiptBarcodesRef.current = receiptBarcodeValues;
  rxBarcodesRef.current = rxBarcodeValues;
  const showCameraRef = useRef(false);
  showCameraRef.current = showCamera;
  // Expose the internal input ref to the parent synchronously before paint
  // so that Tab-key handlers can call .focus() immediately after render.
  if (externalBarcodeInputRef) {
    externalBarcodeInputRef.current = internalInputRef.current;
  }
  const videoRef = useRef(null);
  const hiddenInputRef = useRef(null);
  const codeReaderRef = useRef(null);
  const isReaderActiveRef = useRef(false);
  const streamRef = useRef(null);
  const zxingCanvasRef = useRef(null);
  const scannerBufferRef = useRef('');
  const scannerLeadCharRef = useRef('');
  const scannerModeRef = useRef(false);
  const lastKeyAtRef = useRef(0);
  const scannerResetTimerRef = useRef(null);
  const lastValueRef = useRef('');
  const lastScanAtRef = useRef(0);
  const audioCtxRef = useRef(null);

  const { isMobile } = useDevice();
  const fastThreshold = isMobile ? 50 : 35;
  const allValues = [...receiptBarcodeValues, ...rxBarcodeValues];

  const beep = () => {
    try {
      if (!audioCtxRef.current) audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
      const ctx = audioCtxRef.current;
      if (ctx.state === 'suspended') ctx.resume();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.12);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.14);
    } catch {}
  };

  const addBarcode = useCallback((value) => {
    const trimmed = String(value || '').trim();
    scannerLeadCharRef.current = '';
    const currentAll = [...(receiptBarcodesRef.current || []), ...(rxBarcodesRef.current || [])];
    if (!trimmed || currentAll.includes(trimmed)) {
      setManualInput('');
      if (!showCameraRef.current) setTimeout(() => inputRef.current?.focus(), 0);
      return;
    }

    if (classifyBarcode(trimmed) === 'rx') {
      const updated = [...(rxBarcodesRef.current || []), trimmed];
      rxBarcodesRef.current = updated; // update ref immediately to prevent duplicates
      onRxChange(updated);
    } else {
      const updated = [...(receiptBarcodesRef.current || []), trimmed];
      receiptBarcodesRef.current = updated; // update ref immediately to prevent duplicates
      onReceiptChange(updated);
    }

    setManualInput('');
    if (!showCameraRef.current) setTimeout(() => inputRef.current?.focus(), 0);
  }, [onReceiptChange, onRxChange]);

  const removeReceiptBarcode = useCallback((index) => {
    onReceiptChange(receiptBarcodeValues.filter((_, i) => i !== index));
  }, [onReceiptChange, receiptBarcodeValues]);

  const removeRxBarcode = useCallback((index) => {
    onRxChange(rxBarcodeValues.filter((_, i) => i !== index));
  }, [onRxChange, rxBarcodeValues]);

  const handleInputKeyDown = (e) => {
    if (disabled) return;
    const key = e.key;
    const isChar = key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
    const now = Date.now();
    const delta = now - (lastKeyAtRef.current || 0);

    if (isChar && scannerModeRef.current) {
      e.preventDefault();
      e.stopPropagation();
      lastKeyAtRef.current = now;
      scannerBufferRef.current += key;
      if (scannerResetTimerRef.current) clearTimeout(scannerResetTimerRef.current);
      scannerResetTimerRef.current = setTimeout(() => {
        scannerModeRef.current = false;
        scannerBufferRef.current = '';
        scannerLeadCharRef.current = '';
      }, 400);
      return;
    }

    if (isChar && delta < fastThreshold) {
      e.preventDefault();
      e.stopPropagation();
      scannerModeRef.current = true;
      lastKeyAtRef.current = now;
      scannerBufferRef.current = `${scannerLeadCharRef.current || manualInput || ''}${key}`;
      scannerLeadCharRef.current = '';
      if (manualInput) setManualInput('');
      if (scannerResetTimerRef.current) clearTimeout(scannerResetTimerRef.current);
      scannerResetTimerRef.current = setTimeout(() => {
        scannerModeRef.current = false;
        scannerBufferRef.current = '';
        scannerLeadCharRef.current = '';
      }, 400);
      return;
    }

    if (isChar) {
      scannerLeadCharRef.current = key;
      lastKeyAtRef.current = now;
    }

    if (key === 'Enter') {
      if (scannerModeRef.current && scannerBufferRef.current) {
        e.preventDefault();
        e.stopPropagation();
        addBarcode(scannerBufferRef.current);
        scannerBufferRef.current = '';
        scannerModeRef.current = false;
        return;
      }
      if (manualInput || scannerLeadCharRef.current) {
        e.preventDefault();
        e.stopPropagation();
        addBarcode(manualInput || scannerLeadCharRef.current);
        return;
      }
      // If empty, do not preventDefault or stopPropagation, let it bubble
      return;
    }

    if (scannerModeRef.current && key === 'Backspace') {
      e.preventDefault();
      e.stopPropagation();
      scannerBufferRef.current = scannerBufferRef.current.slice(0, -1);
      lastKeyAtRef.current = now;
      return;
    }

    lastKeyAtRef.current = now;
  };

  const handleCameraDetected = useCallback((value) => {
    const trimmed = String(value || '').trim();
    if (!trimmed) return;
    const now = Date.now();
    if (trimmed === lastValueRef.current && now - lastScanAtRef.current < 800) return;
    lastValueRef.current = trimmed;
    lastScanAtRef.current = now;
    beep();
    setFlashHit(true);
    setTimeout(() => setFlashHit(false), 120);
    addBarcode(trimmed);
  }, [addBarcode]);

  // Native BarcodeDetector + ZXing fallback
  const nativeDetectorRef = useRef(null);
  const nativeScanLoopRef = useRef(null);
  const [cameraError, setCameraError] = useState(null);

  const configureTrack = useCallback((stream) => {
    try {
      const s = stream || streamRef.current || videoRef.current?.srcObject;
      if (s) streamRef.current = s;
      const track = s?.getVideoTracks?.()[0];
      if (!track) return;
      const caps = track.getCapabilities?.() || {};
      if (caps.zoom) {
        setCanZoom(true);
        const target = Math.min(Math.max(2, caps.zoom.min || 1), caps.zoom.max || 1);
        track.applyConstraints({ advanced: [{ zoom: target }] }).catch(() => {});
        setZoom(target);
      }
      if (caps.torch) setHasTorch(true);
      if (caps.focusMode?.includes?.('continuous')) {
        track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
      }
      if (caps.exposureMode?.includes?.('continuous')) {
        track.applyConstraints({ advanced: [{ exposureMode: 'continuous' }] }).catch(() => {});
      }
    } catch {}
  }, []);

  const [cameraLabel, setCameraLabel] = useState('');
  const [cameraCount, setCameraCount] = useState(1);

  const startCamera = useCallback(async () => {
    if (disabled || isReaderActiveRef.current) return;
    setCameraError(null);
    setIsStartingCamera(true);

    try {
      // Open with saved deviceId (if any), or facingMode:ideal
      const savedId = getSavedCameraId();
      let stream = await openStream(savedId);

      // Get camera label + count for the switch button
      try {
        const cams = await listCameras();
        setCameraCount(cams.length);
        const currentId = stream.getVideoTracks()[0]?.getSettings?.()?.deviceId;
        const current = cams.find(c => c.deviceId === currentId);
        setCameraLabel(current?.label || 'Camera');
      } catch {}

      // Attach stream to video element
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        try { await videoRef.current.play(); } catch {}
      }
      streamRef.current = stream;
      isReaderActiveRef.current = true;

      // Configure zoom/torch/focus AFTER stream is live
      configureTrack(stream);

      // Step 3: Clear "Starting camera..." NOW (stream is live and video playing)
      setIsStartingCamera(false);

      // ── Try native BarcodeDetector (5-10x faster on Chrome/Android) ──
      const hasNative = typeof window !== 'undefined' && 'BarcodeDetector' in window;
      if (hasNative) {
        try {
          nativeDetectorRef.current = new window.BarcodeDetector({ formats: ['code_128', 'code_39'] });
          let lastDetectAt = 0;
          nativeScanLoopRef.current = setInterval(async () => {
            if (!isReaderActiveRef.current || !videoRef.current || videoRef.current.readyState < 2) return;
            const now = Date.now();
            if (now - lastDetectAt < 100) return;
            lastDetectAt = now;
            try {
              const barcodes = await nativeDetectorRef.current.detect(videoRef.current);
              if (barcodes?.length > 0) {
                const text = barcodes[0].rawValue || String(barcodes[0].value || '');
                if (text) handleCameraDetected(text);
              }
            } catch {}
          }, 100);
          console.log('[SmartBarcodeScanner] Using native BarcodeDetector');
          return; // stream + loop running — done
        } catch (nativeErr) {
          console.warn('[SmartBarcodeScanner] BarcodeDetector failed, using ZXing:', nativeErr?.message);
          try { clearInterval(nativeScanLoopRef.current); } catch {}
          nativeDetectorRef.current = null;
        }
      }

      // ── ZXing fallback — manual decode loop for faster iOS performance ──
      console.log('[SmartBarcodeScanner] Using ZXing manual decode loop (iOS fallback)');
      codeReaderRef.current = new BrowserMultiFormatReader();
      try {
        const hints = new Map();
        // Only CODE_128 — the most common pharmacy barcode format
        // Limiting formats dramatically speeds up ZXing on iOS
        hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.CODE_128]);
        hints.set(DecodeHintType.ASSUME_GS1, false);
        codeReaderRef.current.setHints(hints);
      } catch {}

      // Manual decode loop — faster than decodeFromStream's internal loop
      // because we control the interval and avoid ZXing's overhead
      let lastDecodeAt = 0;
      nativeScanLoopRef.current = setInterval(async () => {
        if (!isReaderActiveRef.current || !videoRef.current || videoRef.current.readyState < 2) return;
        const now = Date.now();
        if (now - lastDecodeAt < 200) return; // 5fps decode attempts — fast enough, low CPU
        lastDecodeAt = now;
        try {
          // Use decodeFromCanvas — much faster than video element scanning
          // because we can downscale the canvas for faster decode
          if (!zxingCanvasRef.current) zxingCanvasRef.current = document.createElement('canvas');
          const canvas = zxingCanvasRef.current;
          const vw = videoRef.current.videoWidth;
          const vh = videoRef.current.videoHeight;
          if (!vw || !vh) return;
          // Downscale to 640px wide for faster decode on iOS
          const scale = Math.min(1, 640 / vw);
          canvas.width = Math.round(vw * scale);
          canvas.height = Math.round(vh * scale);
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);
          const result = await codeReaderRef.current.decodeFromCanvas(canvas);
          if (result) {
            const text = result.getText ? result.getText() : String(result?.text || '');
            if (text) handleCameraDetected(text);
          }
        } catch {
          // No barcode found this frame — normal
        }
      }, 250); // check every 250ms, decode at 200ms throttle = fast detection
    } catch (e) {
      console.warn('[SmartBarcodeScanner] Camera start failed:', e);
      setCameraError(e?.message || 'Could not access camera');
      setIsStartingCamera(false);
    }
  }, [disabled, handleCameraDetected, configureTrack]);

  const stopCameraReader = useCallback(() => {
    // Stop native scan loop
    try { clearInterval(nativeScanLoopRef.current); } catch {}
    nativeScanLoopRef.current = null;
    nativeDetectorRef.current = null;
    // Stop ZXing reader
    try { if (codeReaderRef.current) { codeReaderRef.current.stop?.(); codeReaderRef.current = null; } } catch {}
    // Detach stream — keep cached stream alive so iOS doesn't re-prompt
    try {
      const stream = streamRef.current || videoRef.current?.srcObject;
      if (stream && stream === getCachedStream() && isStreamAlive(stream)) {
        console.log('[SmartBarcodeScanner] Detaching cached stream (keeping alive)');
        detachStream(videoRef.current);
      } else if (stream?.getTracks) {
        stream.getTracks().forEach((t) => {try {t.stop();} catch {}});
        if (videoRef.current) { try {videoRef.current.srcObject = null;} catch {} }
      }
    } catch {}
    if (videoRef.current) {
      try {videoRef.current.pause();} catch {}
    }
    streamRef.current = null;
    isReaderActiveRef.current = false;
    setCameraError(null);
  }, []);

  const switchCamera = useCallback(async () => {
    if (isStartingCamera) return;
    setIsStartingCamera(true);
    try {
      const result = await cycleRearCamera(videoRef.current);
      if (result?.stream && videoRef.current) {
        videoRef.current.srcObject = result.stream;
        try { await videoRef.current.play(); } catch {}
        streamRef.current = result.stream;
        configureTrack(result.stream);
        if (result.label) setCameraLabel(result.label);
      }
    } catch (e) {
      console.warn('[SmartBarcodeScanner] Switch camera failed:', e?.message);
    } finally {
      setIsStartingCamera(false);
    }
  }, [configureTrack, isStartingCamera]);

  const adjustZoom = (delta) => {
    const track = streamRef.current?.getVideoTracks?.()[0];
    if (!track) return;
    const caps = track.getCapabilities?.();
    if (!caps?.zoom) return;
    const settings = track.getSettings?.() || {};
    const current = settings.zoom ?? zoom ?? caps.zoom.min;
    const next = Math.min(caps.zoom.max, Math.max(caps.zoom.min, current + delta));
    track.applyConstraints({ advanced: [{ zoom: next }] }).catch(() => {});
    setZoom(next);
  };

  const toggleTorch = async () => {
    const track = streamRef.current?.getVideoTracks?.()[0];
    if (!track) return;
    const caps = track.getCapabilities?.();
    if (!caps?.torch) return;
    const next = !torchOn;
    try {await track.applyConstraints({ advanced: [{ torch: next }] });} catch {}
    setTorchOn(next);
  };

  // Refs to hold the latest callbacks without triggering re-runs of the effect
  const startCameraRef = useRef(startCamera);
  const stopCameraReaderRef = useRef(stopCameraReader);
  startCameraRef.current = startCamera;
  stopCameraReaderRef.current = stopCameraReader;

  useEffect(() => {
    window.dispatchEvent(new CustomEvent('cameraOverlayChange', { detail: { open: !!showCamera } }));
    if (showCamera) {
      startCameraRef.current();
    } else {
      stopCameraReaderRef.current();
    }
    return () => {
      if (!showCamera) stopCameraReaderRef.current();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showCamera]);

  useEffect(() => {
    if (!isMobile || showCamera) return;
    try {hiddenInputRef.current?.focus();} catch {}
  }, [showCamera, receiptBarcodeValues.length, rxBarcodeValues.length]);

  useEffect(() => {
    if (!manualInputOverride) return;
    setManualInput(manualInputOverride);
    setTimeout(() => inputRef.current?.focus(), 0);
    onManualInputOverrideApplied();
  }, [manualInputOverride, onManualInputOverrideApplied]);

  useEffect(() => {
    if (!focusTrigger) return;
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [focusTrigger]);

  return (
    <div className="space-y-" onClick={(e) => {if (isMobile && !showCamera && e.target?.tagName !== 'INPUT') hiddenInputRef.current?.focus?.();}}>
      <div className="pb-1 gap- flex items-center gap-1">
        <Barcode className="w-4 h-4 text-emerald-600" />
        <Label className="text-sm font-semibold text-slate-900 dark:text-slate-100">Barcodes</Label>
        {allValues.length > 0 &&
        <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-200 text-xs px-1.5 py-0 h-5">{allValues.length}</Badge>
        }
      </div>

      <div className="flex gap-2 items-center">
        <Input
          ref={inputRef}
          type="text"
          value={manualInput}
          onChange={(e) => {if (!scannerModeRef.current) setManualInput(e.target.value);}}
          onKeyDown={handleInputKeyDown}
          onFocus={() => hiddenInputRef.current?.blur?.()}
          placeholder="Scan or type barcode and press Enter..." className="px-3 py-2 text-sm font-mono rounded-md flex w-full border shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm flex-1 h-9"

          disabled={disabled}
          autoComplete="off" />
        
        <input
          ref={hiddenInputRef}
          type="text"
          className="sr-only absolute -left-[9999px] w-0 h-0 opacity-0"
          onKeyDown={handleInputKeyDown}
          onChange={() => {}}
          autoFocus={isMobile}
          aria-hidden="true"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          inputMode="none" />
        
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-9 px-3 flex-shrink-0 bg-white text-slate-900 border-slate-300 hover:bg-slate-100 dark:bg-slate-800 dark:text-slate-100 dark:border-slate-600 dark:hover:bg-slate-700"
          onClick={() => setShowCamera(true)}
          disabled={disabled}
          title="Scan with camera">
          
          <Camera className="w-4 h-4" />
        </Button>
      </div>

      

      <div className="grid grid-cols-2 md:grid-cols-1">
        <BarcodeColumn
          title="Receipt Barcodes"
          values={receiptBarcodeValues}
          onRemove={removeReceiptBarcode}
          onSelectBarcode={(val) => {
            setSelectedBarcode(val);
            onSelectBarcode(val);
          }}
          countColor="bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-200"
          singleVisible={isMobile} />
        
        <BarcodeColumn
          title="Rx Barcodes"
          values={rxBarcodeValues}
          onRemove={removeRxBarcode}
          onSelectBarcode={(val) => {
            setSelectedBarcode(val);
            onSelectBarcode(val);
          }}
          countColor="bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-200"
          singleVisible={isMobile}
          isRx={true} />
        
      </div>

      {selectedBarcode &&
      <div
        className="fixed inset-0 z-[10029] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
        onClick={() => setSelectedBarcode(null)}>
          <div
          className="relative w-full max-w-3xl rounded-xl border bg-card p-4 shadow-2xl"
          
          onClick={(e) => e.stopPropagation()}>
            <LargeBarcodePreview value={selectedBarcode} onClose={() => setSelectedBarcode(null)} isRx={rxBarcodeValues.includes(selectedBarcode)} />
          </div>
        </div>
      }

      {showCamera && typeof document !== 'undefined' && createPortal(
      <div className="fixed inset-0 z-[10030] bg-black flex flex-col items-center justify-between"
        style={{ paddingTop: 'env(safe-area-inset-top, 12px)', paddingBottom: 'env(safe-area-inset-bottom, 12px)' }}>

        {/* ── Top: viewfinder + status hint + scanned list ── */}
        <div className="w-full max-w-lg flex flex-col items-center px-2 pt-2 gap-2">
          {/* Viewfinder — 50% shorter (16:4.5 instead of 16:9) */}
          <div className="relative w-full" style={{ aspectRatio: '16 / 8' }}>
            <div className={`relative w-full h-full rounded-lg overflow-hidden border-2 transition-colors duration-200 ${
              flashHit ? 'border-emerald-400' : 'border-white/30'
            }`}>
              <video ref={videoRef} className="absolute inset-0 w-full h-full object-cover" playsInline autoPlay muted style={{ objectPosition: 'center' }} />

              {/* Flash hit overlay */}
              {flashHit && (
                <div className="absolute inset-0 bg-emerald-500/30 flex items-center justify-center">
                  <div className="text-white text-lg font-semibold">✓ Scanned</div>
                </div>
              )}

              {/* Camera error overlay */}
              {cameraError && (
                <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                  <div className="text-red-400 text-sm text-center px-4">{cameraError}</div>
                </div>
              )}

              {/* Corner brackets */}
              {!flashHit && !cameraError && (
                <>
                  <div className="absolute top-2 left-2 w-5 h-5 border-t-2 border-l-2 border-white/40 rounded-tl" />
                  <div className="absolute top-2 right-2 w-5 h-5 border-t-2 border-r-2 border-white/40 rounded-tr" />
                  <div className="absolute bottom-2 left-2 w-5 h-5 border-b-2 border-l-2 border-white/40 rounded-bl" />
                  <div className="absolute bottom-2 right-2 w-5 h-5 border-b-2 border-r-2 border-white/40 rounded-br" />
                </>
              )}
            </div>
          </div>

          {/* Status hint — centered white text */}
          <div className="text-white text-sm font-medium text-center px-4">
            {cameraError ? '' : isStartingCamera ? 'Starting camera...' : flashHit ? 'Captured!' : 'Point camera at a barcode'}
          </div>

          {/* Scanned barcodes list — shows each barcode scanned during this session */}
          {allValues.length > 0 && (
            <div className="w-full max-h-[35vh] overflow-y-auto space-y-1.5 pb-1">
              {allValues.map((val, idx) => {
                const isRx = rxBarcodeValues.includes(val);
                return (
                  <div key={`scan-${idx}-${val}`} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/10 border border-white/15">
                    <Badge className={`text-xs px-2 py-0 h-5 flex-shrink-0 ${isRx ? 'bg-emerald-500/30 text-emerald-200' : 'bg-blue-500/30 text-blue-200'}`}>
                      {isRx ? 'Rx' : 'Rec'}
                    </Badge>
                    <span className="text-white text-sm font-mono flex-1 truncate">{val}</span>
                    <Check className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ── Bottom: all buttons pinned to bottom ── */}
        <div className="w-full max-w-lg flex items-center justify-between px-6 pb-3 gap-2">
          {/* Left: switch camera */}
          <div className="w-16 h-16 flex items-center justify-center">
            {cameraCount > 1 ? (
              <button
                type="button"
                onClick={switchCamera}
                disabled={isStartingCamera}
                className="flex items-center justify-center rounded-full bg-white/20 backdrop-blur-sm w-16 h-16 text-white transition active:scale-95 disabled:opacity-50 touch-manipulation"
                style={{ WebkitTapHighlightColor: 'transparent' }}
                title="Switch camera lens"
              >
                {isStartingCamera
                  ? <div className="animate-spin w-6 h-6 border-2 border-white border-t-transparent rounded-full" />
                  : <SwitchCamera className="w-7 h-7" />}
              </button>
            ) : <div className="w-16 h-16" />}
          </div>

          {/* Left-center: zoom out */}
          {canZoom ? (
            <button
              type="button"
              onClick={() => adjustZoom(-0.5)}
              className="flex items-center justify-center rounded-full bg-white/20 backdrop-blur-sm w-14 h-14 text-white transition active:scale-95 touch-manipulation"
              style={{ WebkitTapHighlightColor: 'transparent' }}
              title="Zoom out"
            >
              <Minus className="w-7 h-7" />
            </button>
          ) : <div className="w-16 h-16" />}

          {/* Center: zoom in */}
          {canZoom ? (
            <button
              type="button"
              onClick={() => adjustZoom(0.5)}
              className="flex items-center justify-center rounded-full bg-white/20 backdrop-blur-sm w-14 h-14 text-white transition active:scale-95 touch-manipulation"
              style={{ WebkitTapHighlightColor: 'transparent' }}
              title="Zoom in"
            >
              <ZoomIn className="w-7 h-7" />
            </button>
          ) : <div className="w-16 h-16" />}

          {/* Right-center: torch */}
          {hasTorch ? (
            <button
              type="button"
              onClick={toggleTorch}
              className={`flex items-center justify-center rounded-full w-16 h-16 transition active:scale-95 touch-manipulation ${torchOn ? 'bg-emerald-600 text-white' : 'bg-white/20 backdrop-blur-sm text-white'}`}
              style={{ WebkitTapHighlightColor: 'transparent' }}
              title="Toggle torch"
            >
              <Sun className="w-7 h-7" />
            </button>
          ) : <div className="w-16 h-16" />}

          {/* Right: close (green check when barcodes scanned, X when empty) */}
          <button
            type="button"
            onClick={() => { stopCameraReader(); setShowCamera(false); }}
            className={`flex items-center justify-center rounded-full w-16 h-16 text-white transition active:scale-95 touch-manipulation ${allValues.length > 0 ? 'bg-emerald-600' : 'bg-white/20 backdrop-blur-sm'}`}
            style={{ WebkitTapHighlightColor: 'transparent' }}
            title={allValues.length > 0 ? 'Done' : 'Close camera'}
          >
            {allValues.length > 0 ? <Check className="w-7 h-7" /> : <X className="w-7 h-7" />}
          </button>
        </div>
      </div>
      , document.body)
      }
    </div>);

}