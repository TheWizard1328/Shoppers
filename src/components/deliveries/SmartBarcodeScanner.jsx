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


// iOS detection (module-level, stable): the thin center scan strip is an iOS
// aiming aid only — Android full-frame detection needs no strip guidance.
const isIOSDevice = (() => {
  try {
    const ua = navigator.userAgent || '';
    return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1);
  } catch { return false; }
})();

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
              key={`${title}-${idx}-${val}`} className={`relative w-[95px] flex-shrink-0 rounded-lg border bg-white dark:bg-slate-900 p-1 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800 dark:hover:bg-slate-700${singleVisible ? 'snap-center' : ''}`}
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

const BAND_TOP = 0.30;
const BAND_BOTTOM = 0.70;

/**
 * True when a detected barcode's CENTRE falls inside the aiming band of the
 * video frame. Codes elsewhere in the picture are ignored, so a bag holding
 * several labels no longer auto-collects every one of them.
 */
const barcodeCentreInBand = (bc, videoHeight, bandTop = BAND_TOP, bandBottom = BAND_BOTTOM, videoWidth = 0, x1 = 0, x2 = 1) => {
  try {
    const vh = videoHeight || 0;
    if (!vh) return true; // unknown frame height — never block detection
    // Horizontal window: the preview is cropped at the sides too, so a code
    // outside the visible columns must not be captured either.
    const vw = videoWidth || 0;
    if (vw > 0 && (x1 > 0 || x2 < 1)) {
      let cxVal = null;
      const bbX = bc?.boundingBox;
      if (bbX && bbX.width != null && bbX.x != null) cxVal = (Number(bbX.x) + Number(bbX.width) / 2) / vw;
      else if (Array.isArray(bc?.cornerPoints) && bc.cornerPoints.length) {
        const xs = bc.cornerPoints.map((p) => Number(p?.x ?? p?.X ?? 0)).filter(Number.isFinite);
        if (xs.length) cxVal = ((Math.min(...xs) + Math.max(...xs)) / 2) / vw;
      }
      if (cxVal != null && Number.isFinite(cxVal) && (cxVal < x1 || cxVal > x2)) return false;
    }
    let cy = null;
    const bb = bc?.boundingBox;
    if (bb && bb.height != null && bb.y != null) {
      cy = (Number(bb.y) + Number(bb.height) / 2) / vh;
    } else if (Array.isArray(bc?.cornerPoints) && bc.cornerPoints.length) {
      const ys = bc.cornerPoints.map((p) => Number(p?.y ?? p?.Y ?? 0)).filter(Number.isFinite);
      if (ys.length) cy = ((Math.min(...ys) + Math.max(...ys)) / 2) / vh;
    }
    if (cy == null || !Number.isFinite(cy)) return true;
    return cy >= bandTop && cy <= bandBottom;
  } catch {
    return true;
  }
};

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
  onTabForward = null,
}) {
  const [manualInput, setManualInput] = useState('');
  const [showCamera, setShowCamera] = useState(false);
  const [selectedBarcode, setSelectedBarcode] = useState(null);
  const [isStartingCamera, setIsStartingCamera] = useState(false);
  const [flashHit, setFlashHit] = useState(false);
  // ── Camera frame aspect (owner report Oct 29 2026) ────────────────────────
  // The decoder always scanned the FULL camera frame, but the preview was a
  // fixed 16:8 box with object-cover, so the screen showed a magnified SLICE of
  // that frame. A barcode that looked centred on screen sat somewhere else in
  // the frame the detector actually reads, which is why it "had to be
  // positioned just right" and often had to sit low in the viewfinder.
  // Now the viewfinder takes the camera's real aspect ratio and shows the WHOLE
  // frame (object-contain), so what you see is exactly what is being scanned.
  const [frameAspect, setFrameAspect] = useState(null);
  // ── AIMING BAND (owner report Nov 2 2026) ────────────────────────────────
  // The decoder read the WHOLE camera frame, so one aimed bill of lading could
  // collect every label in view: the owner scanned ONE Rx barcode and got two
  // Rx codes plus the receipt because the bag held all three. Detection is now
  // restricted to the middle band of the picture, which is also the only place
  // the on-screen guide says counts — what you aim at is what gets scanned.
  const BAND_TOP_FRAC = 0.30;
  const BAND_BOTTOM_FRAC = 0.70;
  // Only codes captured in THIS camera session are listed in the overlay — the
  // form's earlier codes stay in the form, they just stop re-listing themselves
  // every time the camera opens.
  const sessionBaseRef = useRef(null);
  const [sessionBase, setSessionBase] = useState([]);
  // Measured viewfinder box, used to place the aiming band guide exactly over
  // the rows the decoder reads once the preview is cover-cropped.
  const viewfinderRef = useRef(null);
  // Decoded rows, as fractions of the CAMERA frame. Recomputed from the real
  // on-screen geometry so the band the engine reads always equals the band the
  // guide draws, even though the preview is cover-cropped.
  const bandRef = useRef({ top: BAND_TOP, bottom: BAND_BOTTOM });
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

  const digitsOf = (v) => String(v || '').replace(/\D/g, '');
  // Does `longer` look like the same physical barcode read in full?
  const isFullerReadOf = (longer, shorter) => {
    const dl = digitsOf(longer);
    const ds = digitsOf(shorter);
    if (!dl || !ds || ds.length < 6 || dl.length <= ds.length) return false;
    return dl.includes(ds);
  };

  const addBarcode = useCallback((value, opts = {}) => {
    const fromCamera = opts?.fromCamera === true;
    const trimmed = String(value || '').trim();
    scannerLeadCharRef.current = '';
    const receipts = [...(receiptBarcodesRef.current || [])];
    const rx = [...(rxBarcodesRef.current || [])];
    const currentAll = [...receipts, ...rx];
    const focusBack = () => {
      setManualInput('');
      if (!showCameraRef.current) setTimeout(() => inputRef.current?.focus(), 0);
    };
    if (!trimmed || currentAll.includes(trimmed)) { focusBack(); return; }

    // A cut-off read of a barcode we already hold is the SAME barcode — never
    // a second entry (owner report Nov 2 2026: duplicates kept appearing).
    if (currentAll.some((v) => isFullerReadOf(v, trimmed))) { focusBack(); return; }
    const fragments = currentAll.filter((v) => isFullerReadOf(trimmed, v));

    if (classifyBarcode(trimmed) === 'rx') {
      const updated = [...rx.filter((v) => !fragments.includes(v)), trimmed];
      rxBarcodesRef.current = updated; // update ref immediately to prevent duplicates
      if (fragments.some((v) => receipts.includes(v))) {
        const nextReceipts = receipts.filter((v) => !fragments.includes(v));
        receiptBarcodesRef.current = nextReceipts;
        onReceiptChange(nextReceipts);
      }
      onRxChange(updated);
    } else {
      // A receipt carries ONE barcode. A shorter read never displaces a longer
      // one; a longer read replaces the fragments already stored. This is what
      // keeps '000' / a 12-digit misread from living beside the real code.
      const best = receipts.reduce((m, v) => (!m || v.length > m.length ? v : m), null);
      // Only camera reads are held to the one-receipt rule — typed and
      // physical-scanner entries are always accepted as given.
      if (fromCamera && best && best.length >= trimmed.length) { focusBack(); return; }
      const updated = fromCamera
        ? [...receipts.filter((v) => !fragments.includes(v) && v !== best), trimmed]
        : [...receipts.filter((v) => !fragments.includes(v)), trimmed];
      receiptBarcodesRef.current = updated; // update ref immediately to prevent duplicates
      onReceiptChange(updated);
    }

    focusBack();
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
    // Tab (without Shift) forwards focus to the COD amount field so the natural
    // flow is barcode input → COD input. Shift+Tab keeps default behavior.
    if (key === 'Tab' && !e.shiftKey && typeof onTabForward === 'function') {
      e.preventDefault();
      onTabForward();
      return;
    }
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

  // ── Camera read confirmation (owner report Nov 2 2026) ──────────────────
  // One frame used to be enough to file a barcode, so a half-read code became
  // a second receipt barcode ('000', a 12-digit misread) sitting beside the
  // real one. A camera hit now needs TWO matching reads inside 2.5s, and short
  // or all-zero fragments are dropped outright.
  const pendingHitsRef = useRef(new Map());
  const MIN_CAMERA_CODE_LEN = 6;
  const CONFIRM_HITS = 2;
  const CONFIRM_WINDOW_MS = 4000;

  const handleCameraDetected = useCallback((value) => {
    const trimmed = String(value || '').trim();
    if (!trimmed) return;
    const compactLen = trimmed.replace(/\s+/g, '').length;
    if (compactLen < MIN_CAMERA_CODE_LEN) return;   // fragment, not a barcode
    if (/^0+$/.test(trimmed)) return;               // padding read

    const now = Date.now();
    const pending = pendingHitsRef.current;
    const prev = pending.get(trimmed);
    if (prev && now - prev.firstAt <= CONFIRM_WINDOW_MS) prev.count += 1;
    else pending.set(trimmed, { count: 1, firstAt: now });
    for (const [k, v] of pending) {
      if (now - v.firstAt > CONFIRM_WINDOW_MS) pending.delete(k);
    }
    const hits = pending.get(trimmed)?.count || 0;
    if (hits < CONFIRM_HITS) return; // wait for a second matching read
    pending.delete(trimmed);

    if (trimmed === lastValueRef.current && now - lastScanAtRef.current < 800) return;
    lastValueRef.current = trimmed;
    lastScanAtRef.current = now;
    beep();
    setFlashHit(true);
    setTimeout(() => setFlashHit(false), 120);
    addBarcode(trimmed, { fromCamera: true });
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

  // ── Band geometry from the real preview box (owner report Nov 2 2026) ────
  // The preview fills a fixed-height, full-width box with object-cover, so the
  // camera frame is cropped top/bottom. The guide is drawn over the middle 40%
  // of the BOX; this maps that box band back into camera-frame rows so the
  // decoder reads exactly what the guide shows.
  useEffect(() => {
    if (!showCamera) return;
    const el = viewfinderRef.current;
    if (!el) return;
    const recompute = () => {
      try {
        const rect = el.getBoundingClientRect();
        const boxW = rect.width || 0;
        const boxH = rect.height || 0;
        const m = /^([\d.]+)\s*\/\s*([\d.]+)$/.exec(String(frameAspect || ''));
        const vw = m ? Number(m[1]) : 0;
        const vh = m ? Number(m[2]) : 0;
        if (!boxW || !boxH || !vw || !vh) {
          bandRef.current = { top: BAND_TOP, bottom: BAND_BOTTOM, x1: 0, x2: 1 };
          return;
        }
        // The preview shows ONLY the band rows, blown up to fill the box, so
        // the decoded rows and the visible picture are the same rectangle.
        const bandFrac = BAND_BOTTOM - BAND_TOP;
        const dispH = boxH / bandFrac;     // video display height in px
        const dispW = dispH * (vw / vh);   // keeps the camera aspect ratio
        const x1 = dispW > boxW ? ((dispW - boxW) / 2) / dispW : 0;
        bandRef.current = { top: BAND_TOP, bottom: BAND_BOTTOM, x1, x2: 1 - x1 };
      } catch {
        bandRef.current = { top: BAND_TOP, bottom: BAND_BOTTOM, x1: 0, x2: 1 };
      }
    };
    recompute();
    let ro = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(recompute);
      try { ro.observe(el); } catch {}
    }
    window.addEventListener('resize', recompute);
    window.addEventListener('orientationchange', recompute);
    return () => {
      try { ro?.disconnect(); } catch {}
      window.removeEventListener('resize', recompute);
      window.removeEventListener('orientationchange', recompute);
    };
  }, [showCamera, frameAspect]);

  const [cameraLabel, setCameraLabel] = useState('');
  const [cameraCount, setCameraCount] = useState(1);

  // ── ZXing fallback — strip-cropped decode + edge-density pre-check ──
  // Extracted as a useCallback so it can be called from both the initial
  // startCamera path (no BarcodeDetector) and the BarcodeDetector failure path.
  const startZxingFallback = useCallback(() => {
    // ── ZXing fallback — full-frame decode ──
    // Scans the FULL video frame (downscaled to max 800px wide for speed + accuracy).
    // Two-pass approach: fast decode (no TRY_HARDER) at 80ms intervals for real-time
    // detection, then TRY_HARDER every 5th frame for difficult/blurry barcodes.
    if (codeReaderRef.current) return; // already running
    console.log('[SmartBarcodeScanner] Using ZXing full-frame decode');
    codeReaderRef.current = new BrowserMultiFormatReader();

    // Hints without TRY_HARDER — fast pass
    const fastHints = new Map();
    fastHints.set(DecodeHintType.POSSIBLE_FORMATS, [
      BarcodeFormat.CODE_128, BarcodeFormat.CODE_39,
      BarcodeFormat.EAN_13, BarcodeFormat.EAN_8,
      BarcodeFormat.UPC_A, BarcodeFormat.UPC_E,
      BarcodeFormat.ITF, BarcodeFormat.CODABAR
    ]);
    fastHints.set(DecodeHintType.ASSUME_GS1, false);
    fastHints.set(DecodeHintType.PURE_FORMATS, false);

    // Hints with TRY_HARDER — slow pass for difficult barcodes
    const slowHints = new Map(fastHints);
    slowHints.set(DecodeHintType.TRY_HARDER, true);

    try { codeReaderRef.current.setHints(fastHints); } catch {}

    if (!zxingCanvasRef.current) zxingCanvasRef.current = document.createElement('canvas');
    const zxingCanvas = zxingCanvasRef.current;
    const zxingCtx = zxingCanvas.getContext('2d', { willReadFrequently: true });

    let frameCount = 0;
    let usingSlowHints = false;

    const decodeLoop = () => {
      if (!isReaderActiveRef.current || !videoRef.current || videoRef.current.readyState < 2) {
        if (isReaderActiveRef.current) nativeScanLoopRef.current = setTimeout(decodeLoop, 100);
        return;
      }
      try {
        const vw = videoRef.current.videoWidth;
        const vh = videoRef.current.videoHeight;
        if (!vw || !vh) { nativeScanLoopRef.current = setTimeout(decodeLoop, 100); return; }

        // Downscale full frame to max 800px wide for ZXing (keeps aspect ratio).
        // 800px gives better resolution than 640px for small pharmacy barcodes.
        // BAND CROP (owner report Nov 2 2026): only the middle band is decoded,
        // matching what the on-screen guide shows. Cropping also keeps more
        // pixels per barcode than downscaling the whole frame did.
        const bandY = Math.round(vh * bandRef.current.top);
        const bandH = Math.max(1, Math.round(vh * (bandRef.current.bottom - bandRef.current.top)));
        const bandX = Math.round(vw * (bandRef.current.x1 || 0));
        const bandW = Math.max(1, Math.round(vw * ((bandRef.current.x2 ?? 1) - (bandRef.current.x1 || 0))));
        const scale = Math.min(1, 800 / bandW);
        zxingCanvas.width = Math.round(bandW * scale);
        zxingCanvas.height = Math.max(1, Math.round(bandH * scale));
        zxingCtx.drawImage(videoRef.current, bandX, bandY, bandW, bandH, 0, 0, zxingCanvas.width, zxingCanvas.height);

        // Every 5th frame, use TRY_HARDER for difficult/blurry barcodes
        frameCount++;
        const useSlow = (frameCount % 5 === 0);
        if (useSlow !== usingSlowHints) {
          try { codeReaderRef.current.setHints(useSlow ? slowHints : fastHints); } catch {}
          usingSlowHints = useSlow;
        }

        // Attempt ZXing decode on full frame (synchronous, throws NotFoundException if none found)
        const result = codeReaderRef.current.decodeFromCanvas(zxingCanvas);
        if (result) {
          const text = result.getText ? result.getText() : String(result?.text || '');
          if (text) handleCameraDetected(text);
        }

        // ── Multi-barcode grid pass (owner request, Sep 28 2026) ──────────
        // ZXing returns only the FIRST barcode it finds per decode, so a frame
        // containing TWO patient labels yields just one value. Every 3rd
        // frame, ALSO decode a 2x2 grid of overlapping crops of the FULL-RES
        // frame and feed every DISTINCT value to handleCameraDetected — dedupe
        // (800ms same-value window + addBarcode's existing-value check) keeps
        // it clean, so multiple labels in view auto-collect one beep each.
        if (frameCount % 3 === 0) {
          const foundThisPass = new Set();
          const OVER = 0.12; // overlap fraction — barcodes spanning a grid line stay decodable
          // Grid lives INSIDE the aiming band: two labels side by side in the
          // band still both collect, but nothing outside the band does.
          const bandTopPx = Math.round(vh * bandRef.current.top);
          const bandHeightPx = Math.max(1, Math.round(vh * (bandRef.current.bottom - bandRef.current.top)));
          const bandLeftPx = Math.round(vw * (bandRef.current.x1 || 0));
          const bandWidthPx = Math.max(1, Math.round(vw * ((bandRef.current.x2 ?? 1) - (bandRef.current.x1 || 0))));
          const cols = 2, rows = 2;
          const cw = bandWidthPx / cols, ch = bandHeightPx / rows;
          for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
              const sx = Math.max(bandLeftPx, bandLeftPx + c * cw - cw * OVER);
              const sy = Math.max(bandTopPx, bandTopPx + r * ch - ch * OVER);
              const sw = Math.min(bandLeftPx + bandWidthPx - sx, cw * (1 + 2 * OVER));
              const sh = Math.min(bandTopPx + bandHeightPx - sy, ch * (1 + 2 * OVER));
              if (sw < 100 || sh < 100) continue;
              const cropScale = Math.min(1, 800 / sw);
              zxingCanvas.width = Math.round(sw * cropScale);
              zxingCanvas.height = Math.round(sh * cropScale);
              zxingCtx.drawImage(videoRef.current, sx, sy, sw, sh, 0, 0, zxingCanvas.width, zxingCanvas.height);
              try {
                const cropResult = codeReaderRef.current.decodeFromCanvas(zxingCanvas);
                const t = cropResult?.getText ? cropResult.getText() : String(cropResult?.text || '');
                if (t && !foundThisPass.has(t)) foundThisPass.add(t);
              } catch { /* NotFound — normal */ }
            }
          }
          for (const t of foundThisPass) handleCameraDetected(t);
        }
      } catch {
        // NotFoundException — no barcode this frame, normal
      }
      if (isReaderActiveRef.current) nativeScanLoopRef.current = setTimeout(decodeLoop, 100);
    };
    decodeLoop();

  }, [handleCameraDetected]);

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
      // Owner fix (Sep 29 2026): the APK skip is REMOVED — Android WebView is
      // Chromium and normally ships a working BarcodeDetector; skipping it
      // forced the APK onto the ZXing fallback, whose weaker full-frame decode
      // made barcodes only register when held big/close inside the thin strip.
      // Native detect() scans the WHOLE frame at full resolution and returns
      // every barcode in view (old Android behavior). The existing failure
      // guards cover WebViews where it exists but silently fails: 5s of empty
      // results starts the ZXing backup alongside; 10 consecutive detect()
      // errors cut over to ZXing entirely.
      const hasNative = typeof window !== 'undefined' && 'BarcodeDetector' in window;
      if (hasNative) {
        try {
          // Use getSupportedFormats() to avoid constructor throwing on unsupported formats.
          // This was the root cause of the web/PWA breakage: adding ean_13/upc_a/etc to the
          // constructor caused it to throw on Chrome versions that don't support those formats,
          // which fell through to ZXing (with its narrow strip-crop).
          const wantedFormats = ['code_128', 'code_39', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'itf', 'codabar'];
          let bdFormats = wantedFormats;
          if (typeof window.BarcodeDetector.getSupportedFormats === 'function') {
            try {
              const supported = await window.BarcodeDetector.getSupportedFormats();
              bdFormats = wantedFormats.filter(f => supported.includes(f));
              if (bdFormats.length === 0) bdFormats = ['code_128', 'code_39']; // safe fallback
              console.log('[SmartBarcodeScanner] BarcodeDetector supported formats:', bdFormats.join(', '));
            } catch (e) {
              console.warn('[SmartBarcodeScanner] getSupportedFormats() failed, using defaults:', e?.message);
              bdFormats = ['code_128', 'code_39']; // safe fallback — known supported everywhere
            }
          }
          nativeDetectorRef.current = new window.BarcodeDetector({ formats: bdFormats });
          let lastDetectAt = 0;
          let bdFailCount = 0;
          let bdWarnedAt = 0;
          let bdEmptyCount = 0;
          nativeScanLoopRef.current = setInterval(async () => {
            if (!isReaderActiveRef.current || !videoRef.current || videoRef.current.readyState < 2) return;
            const now = Date.now();
            if (now - lastDetectAt < 100) return;
            lastDetectAt = now;
            try {
              const barcodes = await nativeDetectorRef.current.detect(videoRef.current);
              bdFailCount = 0; // reset on successful detect() call (even if empty)
              if (barcodes?.length > 0) {
                bdEmptyCount = 0;
                // Multi-barcode (owner request, Sep 28 2026): detect() returns EVERY
                // barcode in the frame — feed each DISTINCT value so a bag with two
                // labels auto-collects both. Dedupe (800ms same-value window +
                // addBarcode's existing check) keeps repeats clean.
                const seenThisFrame = new Set();
                for (const bc of barcodes) {
                  const text = bc?.rawValue || String(bc?.value || '');
                  if (!text || seenThisFrame.has(text)) continue;
                  if (!barcodeCentreInBand(
                    bc,
                    videoRef.current?.videoHeight,
                    bandRef.current.top,
                    bandRef.current.bottom,
                    videoRef.current?.videoWidth,
                    bandRef.current.x1,
                    bandRef.current.x2
                  )) continue; // outside the visible scan window — ignore
                  seenThisFrame.add(text);
                  handleCameraDetected(text);
                }
              } else {
                bdEmptyCount++;
                // If detect() returns empty 50 times (5 seconds at 100ms), start ZXing as backup
                if (bdEmptyCount === 50 && !codeReaderRef.current) {
                  console.warn('[SmartBarcodeScanner] BarcodeDetector returning empty for 5s — starting ZXing backup');
                  startZxingFallback();
                }
              }
            } catch (e) {
              bdFailCount++;
              if (bdFailCount === 5 && now - bdWarnedAt > 10000) {
                bdWarnedAt = now;
                console.warn('[SmartBarcodeScanner] BarcodeDetector.detect() failed 5x:', e?.message);
              }
              // After 10 consecutive failures, fall through to ZXing
              if (bdFailCount >= 10 && !codeReaderRef.current) {
                console.warn('[SmartBarcodeScanner] BarcodeDetector unreliable — starting ZXing fallback');
                try { clearInterval(nativeScanLoopRef.current); } catch {}
                nativeScanLoopRef.current = null;
                nativeDetectorRef.current = null;
                startZxingFallback();
              }
            }
          }, 100);
          console.log('[SmartBarcodeScanner] Using native BarcodeDetector');
          return; // stream + loop running — done
        } catch (nativeErr) {
          console.warn('[SmartBarcodeScanner] BarcodeDetector failed, using ZXing:', nativeErr?.message);
          try { clearInterval(nativeScanLoopRef.current); } catch {}
          nativeDetectorRef.current = null;
        }
      }

      // ── ZXing fallback — full-frame decode ──
      startZxingFallback();
    } catch (e) {
      console.warn('[SmartBarcodeScanner] Camera start failed:', e);
      setCameraError(e?.message || 'Could not access camera');
      setIsStartingCamera(false);
    }
  }, [disabled, handleCameraDetected, configureTrack, startZxingFallback]);

  const stopCameraReader = useCallback(() => {
    // Stop scan loop (handles both setInterval and setTimeout)
    try { clearTimeout(nativeScanLoopRef.current); } catch {}
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
          autoComplete="off"
          data-keyboard-safe-scan="true" />
        
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
          inputMode="none"
          data-keyboard-safe-scan="true" />
        
        {isMobile &&
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-9 px-3 flex-shrink-0 bg-white dark:bg-slate-900 text-slate-900 border-slate-300 hover:bg-slate-100 dark:text-slate-100 dark:border-slate-600 dark:hover:bg-slate-700"
          onClick={() => {
            // Snapshot what the form already holds so the overlay only lists
            // codes captured in THIS session (owner report Nov 2 2026).
            const base = [...(receiptBarcodesRef.current || []), ...(rxBarcodesRef.current || [])];
            sessionBaseRef.current = base;
            setSessionBase(base);
            setShowCamera(true);
          }}
          disabled={disabled}
          title="Scan with camera"
          aria-label="Scan with camera">
          
          <Camera className="w-4 h-4" />
        </Button>
        }
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
        className="fixed inset-0 z-[1000000] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
        onClick={() => setSelectedBarcode(null)}>
          <div
          className="relative w-full max-w-3xl rounded-xl border bg-card p-4 shadow-2xl"
          
          onClick={(e) => e.stopPropagation()}>
            <LargeBarcodePreview value={selectedBarcode} onClose={() => setSelectedBarcode(null)} isRx={rxBarcodeValues.includes(selectedBarcode)} />
          </div>
        </div>
      }

      {showCamera && typeof document !== 'undefined' && createPortal(
      <div className="fixed inset-0 z-[1000000] bg-black flex flex-col items-center justify-between"
        style={{ paddingTop: 'env(safe-area-inset-top, 12px)', paddingBottom: 'max(40px, env(safe-area-inset-bottom, 34px))' }}>
        <style>{`
          @keyframes barcodeScan {
            0%, 100% { transform: translateY(-50%); opacity: 0.3; }
            50% { transform: translateY(50%); opacity: 1; }
          }
        `}</style>

        {/* ── Top: viewfinder + status hint + scanned list ──
             min-h-0 + overflow-hidden keeps this block from growing past the
             screen no matter how many codes are listed (owner report Nov 2
             2026: the check button kept sliding under the taskbar). */}
        <div className="w-full max-w-lg flex-1 min-h-0 overflow-hidden flex flex-col items-center px-2 pt-2 gap-2">
          {/* Viewfinder — 50% shorter (16:4.5 instead of 16:9) */}
          <div
            ref={viewfinderRef}
            className="relative w-full"
            style={{
              // OWNER REPORT Nov 2 2026 (second pass): capping the height while
              // keeping the camera's own aspect ratio made the window far too
              // NARROW on a portrait phone (a 3:4 camera in a 42vh box is only
              // ~31vh wide). The box is now FULL WIDTH with a fixed 42vh height
              // and the preview fills it (object-cover), so the picture is wide
              // and the camera frame is cropped top/bottom. The aiming band guide
              // below is positioned from the measured video geometry, so it still
              // marks exactly the rows the decoder reads.
              height: '42vh',
              maxHeight: '42vh',
            }}>
            <div className={`relative w-full h-full rounded-lg overflow-hidden border-2 transition-colors duration-200 ${
              flashHit ? 'border-emerald-400' : 'border-white/30'
            }`}>
              <video
                ref={videoRef}
                className="absolute max-w-none"
                playsInline
                autoPlay
                muted
                style={{
                  // Show ONLY the band: the video is scaled so those rows fill
                  // the box entirely — no dimmed strips above or below (owner
                  // request Nov 2 2026).
                  top: `${-(BAND_TOP / (BAND_BOTTOM - BAND_TOP)) * 100}%`,
                  left: '50%',
                  transform: 'translateX(-50%)',
                  height: `${100 / (BAND_BOTTOM - BAND_TOP)}%`,
                  width: 'auto',
                  background: '#000',
                }}
                onLoadedMetadata={(e) => {
                  // Match the viewfinder to the camera's own frame so the
                  // preview and the decoder see the SAME picture (no crop).
                  const v = e.currentTarget;
                  if (v?.videoWidth && v?.videoHeight) setFrameAspect(`${v.videoWidth} / ${v.videoHeight}`);
                }}
                onResize={(e) => {
                  const v = e.currentTarget;
                  if (v?.videoWidth && v?.videoHeight) setFrameAspect(`${v.videoWidth} / ${v.videoHeight}`);
                }}
              />

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

              {/* AIMING BAND GUIDE — shown on EVERY device (owner report Nov 2
                  2026). Detection is restricted to this middle band, so the
                  guide is now the truth: whatever sits inside it is scanned,
                  whatever sits outside it is not. The area above and below is
                  dimmed so it is obvious where the band ends. */}
              {!flashHit && !cameraError && (
                <>
                  {/* No dimmed strips: everything on screen is scanned, so
                      everything on screen is the band. */}
                  <div className="absolute inset-0 border-2 border-white/60 rounded-lg pointer-events-none" />
                  {isIOSDevice && (
                    <div
                      className="absolute inset-0 pointer-events-none overflow-hidden"
                    >
                      <div
                        className="absolute left-0 right-0 h-0.5 bg-red-500 shadow-[0_0_8px_2px_rgba(239,68,68,0.6)]"
                        style={{ animation: 'barcodeScan 1.8s ease-in-out infinite', top: '50%' }}
                      />
                    </div>
                  )}
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
            {cameraError ? '' : isStartingCamera ? 'Starting camera...' : flashHit ? 'Captured!' : 'Line up ONE barcode inside the band'}
          </div>

          {/* Scanned barcodes list — THIS session only, capped and scrollable so
              it can never push the round buttons off the bottom of the screen.
              Codes the form already had are NOT re-listed here (owner report
              Nov 2 2026: the overlay appeared to pre-load the last scan). */}
          {allValues.filter((v) => !sessionBase.includes(v)).length > 0 && (
            <div className="w-full flex-1 min-h-0 max-h-[20vh] overflow-y-auto space-y-1.5 pb-1">
              {allValues.filter((v) => !sessionBase.includes(v)).map((val, idx) => {
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
        <div className="w-full max-w-lg flex flex-shrink-0 items-center justify-between px-6 pb-4 gap-2">
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
                aria-label="Switch camera lens"
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
              aria-label="Zoom out"
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
              aria-label="Zoom in"
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
              aria-label="Toggle torch"
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
            aria-label={allValues.length > 0 ? 'Done — finish scanning' : 'Close camera'}
          >
            {allValues.length > 0 ? <Check className="w-7 h-7" /> : <X className="w-7 h-7" />}
          </button>
        </div>
      </div>
      , document.body)
      }
    </div>);

}