import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Camera, Barcode, Minus, Sun, ZoomIn, X } from 'lucide-react';
import { BrowserMultiFormatReader } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType } from '@zxing/library';
import { isMobileDevice } from '@/components/utils/deviceUtils';
import BarcodeThumb from './BarcodeThumb';
import LargeBarcodePreview from './LargeBarcodePreview';

const classifyBarcode = (value) => {
  const raw = String(value || '').trim();
  const normalized = raw.replace(/\s+/g, '');
  const compact = normalized.replace(/^RX[#:\-]*/i, '');

  if (!compact) return 'receipt';
  if (/^rx[#:\-\s]*/i.test(raw)) return 'rx';

  if (/^\d+$/.test(compact)) {
    if (/^96/.test(compact) && compact.length >= 30) return 'rx';
    if (/^99/.test(compact) && compact.length >= 20 && compact.length < 30) return 'receipt';
    if (compact.length >= 30) return 'rx';
    if (compact.length >= 20) return 'receipt';
    if (compact.length >= 4) return 'rx';
  }

  if (/^[A-Za-z]{0,3}\d{4,12}$/.test(compact) && !/[-/.]/.test(compact)) return 'rx';
  if (/^[A-Za-z0-9]{4,12}$/.test(compact) && !/[\-/.]/.test(compact)) return 'rx';
  return 'receipt';
};

function BarcodeColumn({ title, values, onRemove, onSelectBarcode, countColor, singleVisible = false }) {
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
              style={{ borderColor: 'var(--border-slate-200)', scrollSnapStop: singleVisible ? 'always' : 'normal' }}

              onClick={() => onSelectBarcode(val)}
              title={val}>
              <BarcodeThumb value={val} />
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

      <div className="h-[52px] rounded-md border border-dashed flex items-center justify-center text-xs text-slate-400">
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
  onManualInputOverrideApplied = () => {}
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

  const inputRef = useRef(null);
  const videoRef = useRef(null);
  const hiddenInputRef = useRef(null);
  const codeReaderRef = useRef(null);
  const isReaderActiveRef = useRef(false);
  const streamRef = useRef(null);
  const scannerBufferRef = useRef('');
  const scannerLeadCharRef = useRef('');
  const scannerModeRef = useRef(false);
  const lastKeyAtRef = useRef(0);
  const scannerResetTimerRef = useRef(null);
  const lastValueRef = useRef('');
  const lastScanAtRef = useRef(0);
  const audioCtxRef = useRef(null);

  const isMobile = isMobileDevice();
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
    if (!trimmed || allValues.includes(trimmed)) {
      setManualInput('');
      setTimeout(() => inputRef.current?.focus(), 0);
      return;
    }

    if (classifyBarcode(trimmed) === 'rx') {
      onRxChange([...(rxBarcodeValues || []), trimmed]);
    } else {
      onReceiptChange([...(receiptBarcodeValues || []), trimmed]);
    }

    setManualInput('');
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [allValues, onReceiptChange, onRxChange, receiptBarcodeValues, rxBarcodeValues]);

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
      e.preventDefault();
      e.stopPropagation();
      if (scannerModeRef.current && scannerBufferRef.current) {
        addBarcode(scannerBufferRef.current);
        scannerBufferRef.current = '';
        scannerModeRef.current = false;
        return;
      }
      addBarcode(manualInput || scannerLeadCharRef.current);
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

  const startCamera = useCallback(async () => {
    if (disabled || isReaderActiveRef.current) return;
    try {
      setIsStartingCamera(true);
      codeReaderRef.current = new BrowserMultiFormatReader();
      isReaderActiveRef.current = true;

      let selectedDeviceId = null;
      try {
        const inputs = await BrowserMultiFormatReader.listVideoInputDevices();
        const back = inputs.find((d) => /back|rear|environment/i.test(d.label));
        selectedDeviceId = (back || inputs[inputs.length - 1])?.deviceId || null;
      } catch {}

      const constraints = {
        video: {
          deviceId: selectedDeviceId ? { exact: selectedDeviceId } : undefined,
          facingMode: { ideal: 'environment' },
          width: { min: 1280, ideal: 1920 },
          height: { min: 720, ideal: 1080 },
          aspectRatio: { ideal: 16 / 9 },
          frameRate: { ideal: 30, max: 60 }
        },
        audio: false
      };

      try {
        const hints = new Map();
        hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.CODE_128, BarcodeFormat.CODE_39]);
        hints.set(DecodeHintType.TRY_HARDER, true);
        hints.set(DecodeHintType.ASSUME_GS1, true);
        hints.set(DecodeHintType.ALSO_INVERTED, true);
        codeReaderRef.current.setHints(hints);
      } catch {}

      codeReaderRef.current.decodeFromConstraints(constraints, videoRef.current, (result) => {
        if (result) {
          const text = result.getText ? result.getText() : String(result?.text || '');
          if (text) handleCameraDetected(text);
        }
      });

      setTimeout(() => {
        try {
          const stream = videoRef.current?.srcObject;
          streamRef.current = stream || null;
          const track = stream?.getVideoTracks?.()[0];
          if (!track) return;
          const caps = track.getCapabilities?.() || {};
          if (caps.zoom) {
            setCanZoom(true);
            const target = Math.min(Math.max(2, caps.zoom.min || 1), caps.zoom.max || 1);
            track.applyConstraints({ advanced: [{ zoom: target }] }).catch(() => {});
            setZoom(target);
          }
          if (caps.torch) setHasTorch(true);
        } catch {}
      }, 300);
    } catch (e) {
      console.warn('Camera start failed', e);
    } finally {
      setIsStartingCamera(false);
    }
  }, [disabled, handleCameraDetected]);

  const stopCameraReader = useCallback(() => {
    try {codeReaderRef.current?.reset?.();} catch {}
    try {
      const stream = streamRef.current || videoRef.current?.srcObject;
      if (stream?.getTracks) stream.getTracks().forEach((t) => {try {t.stop();} catch {}});
    } catch {}
    if (videoRef.current) {
      try {videoRef.current.pause();} catch {}
      try {videoRef.current.srcObject = null;} catch {}
    }
    streamRef.current = null;
    isReaderActiveRef.current = false;
  }, []);

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

  useEffect(() => {
    if (showCamera) startCamera();else
    stopCameraReader();
    return () => stopCameraReader();
  }, [showCamera, startCamera, stopCameraReader]);

  useEffect(() => {
    if (!isMobile || showCamera) return;
    try {hiddenInputRef.current?.focus();} catch {}
  }, [isMobile, showCamera, receiptBarcodeValues.length, rxBarcodeValues.length]);

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
          className="h-9 px-3 flex-shrink-0 sm:hidden bg-white text-slate-900 border-slate-300 hover:bg-slate-100 dark:bg-slate-800 dark:text-slate-100 dark:border-slate-600 dark:hover:bg-slate-700"
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
          singleVisible={isMobile} />
        
      </div>

      {selectedBarcode &&
      <div
        className="fixed inset-0 z-[10029] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
        onClick={() => setSelectedBarcode(null)}>
          <div
          className="relative w-full max-w-3xl rounded-xl border bg-card p-4 shadow-2xl"
          style={{ borderColor: 'var(--border-slate-200)' }}
          onClick={(e) => e.stopPropagation()}>
            <LargeBarcodePreview value={selectedBarcode} onClose={() => setSelectedBarcode(null)} />
          </div>
        </div>
      }

      {showCamera &&
      <div className="fixed inset-0 z-[10030] bg-black/50 backdrop-blur-sm">
          <div className="relative w-screen mx-auto mt-[10vh] px-0">
            <div className={`relative mx-auto w-screen aspect-video border-2 ${flashHit ? 'border-emerald-400' : 'border-white/80'} rounded-md overflow-hidden bg-black/20`}>
              <video ref={videoRef} className="w-full h-full object-cover" playsInline autoPlay muted />
            </div>
            <div className="mt-3 flex items-center justify-between text-white/90">
              <div className="flex items-center gap-2">
                <div className="text-sm">{allValues.length} scanned</div>
                {canZoom &&
              <div className="ml-1 flex items-center gap-1">
                    <Button variant="secondary" size="sm" onClick={() => adjustZoom(-0.5)} title="Zoom out">
                      <Minus className="w-4 h-4" />
                    </Button>
                    <Button variant="secondary" size="sm" onClick={() => adjustZoom(0.5)} title="Zoom in">
                      <ZoomIn className="w-4 h-4" />
                    </Button>
                  </div>
              }
                {hasTorch &&
              <Button variant="secondary" size="sm" onClick={toggleTorch} className={torchOn ? 'bg-emerald-600 hover:bg-emerald-700 text-white' : ''}>
                    <Sun className="w-4 h-4 mr-1" /> {torchOn ? 'Torch On' : 'Torch'}
                  </Button>
              }
              </div>
              <Button variant="secondary" size="sm" onClick={() => {stopCameraReader();setShowCamera(false);}}>
                <X className="w-4 h-4 mr-1" /> Close
              </Button>
            </div>
            <div className="mt-2 text-center text-xs text-white/70">
              {isStartingCamera ? 'Starting camera...' : flashHit ? 'Captured!' : 'Point camera at a barcode'}
            </div>
          </div>
        </div>
      }
    </div>);

}