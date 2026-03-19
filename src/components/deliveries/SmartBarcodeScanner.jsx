import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { X, Camera, Barcode, Minus, Sun, ZoomIn } from 'lucide-react';
import { BrowserMultiFormatReader } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType } from '@zxing/library';
import { isMobileDevice } from '@/components/utils/deviceUtils';
import BarcodeThumb from './BarcodeThumb';

const classifyBarcode = (value) => {
  const normalized = String(value || '').trim();
  const upper = normalized.toUpperCase();
  const digits = normalized.replace(/\D/g, '');

  if (!normalized) return 'rx';
  if (/^(TR|RCPT|RECEIPT|REC|PAY|SALE|POS)/.test(upper) || /RECEIPT|PAYMENT|TERMINAL/.test(upper)) return 'receipt';
  if (/^(RX|DIN|NDC)/.test(upper) || /PRESCRIPTION|SCRIPT/.test(upper)) return 'rx';
  if (/^[A-Z]{2,}\d{4,}$/.test(upper)) return 'receipt';
  if (/^\d+$/.test(digits)) return digits.length <= 8 ? 'receipt' : 'rx';

  return 'rx';
};

export default function SmartBarcodeScanner({
  receiptValues = [],
  rxValues = [],
  onReceiptChange,
  onRxChange,
  disabled = false,
  onSelectBarcode = () => {}
}) {
  const [manualInput, setManualInput] = useState('');
  const [showCamera, setShowCamera] = useState(false);
  const [isStartingCamera, setIsStartingCamera] = useState(false);
  const [flashHit, setFlashHit] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [canZoom, setCanZoom] = useState(false);
  const [hasTorch, setHasTorch] = useState(false);
  const [torchOn, setTorchOn] = useState(false);

  const inputRef = useRef(null);
  const hiddenInputRef = useRef(null);
  const videoRef = useRef(null);
  const codeReaderRef = useRef(null);
  const isReaderActiveRef = useRef(false);
  const streamRef = useRef(null);
  const audioCtxRef = useRef(null);
  const lastValueRef = useRef('');
  const lastScanAtRef = useRef(0);
  const scannerBufferRef = useRef('');
  const scannerModeRef = useRef(false);
  const lastKeyAtRef = useRef(0);
  const scannerResetTimerRef = useRef(null);

  const isMobile = isMobileDevice();
  const fastThreshold = isMobile ? 50 : 35;
  const allValues = [...receiptValues, ...rxValues];

  const appendBarcode = useCallback((value) => {
    const trimmed = String(value || '').trim();
    if (!trimmed || allValues.includes(trimmed)) {
      setManualInput('');
      setTimeout(() => inputRef.current?.focus?.(), 0);
      return;
    }

    if (classifyBarcode(trimmed) === 'receipt') {
      onReceiptChange([...(receiptValues || []), trimmed]);
    } else {
      onRxChange([...(rxValues || []), trimmed]);
    }

    setManualInput('');
    setTimeout(() => inputRef.current?.focus?.(), 0);
  }, [allValues, onReceiptChange, onRxChange, receiptValues, rxValues]);

  const removeBarcode = useCallback((type, index) => {
    if (type === 'receipt') {
      onReceiptChange(receiptValues.filter((_, i) => i !== index));
      return;
    }
    onRxChange(rxValues.filter((_, i) => i !== index));
  }, [onReceiptChange, onRxChange, receiptValues, rxValues]);

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

  const handleInputKeyDown = (e) => {
    if (disabled) return;
    const key = e.key;
    const isChar = key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
    const now = Date.now();
    const delta = now - (lastKeyAtRef.current || 0);

    if (isChar && (delta < fastThreshold || scannerModeRef.current)) {
      e.preventDefault();
      e.stopPropagation();
      scannerModeRef.current = true;
      lastKeyAtRef.current = now;
      scannerBufferRef.current += key;

      if (scannerResetTimerRef.current) clearTimeout(scannerResetTimerRef.current);
      scannerResetTimerRef.current = setTimeout(() => {
        scannerModeRef.current = false;
        scannerBufferRef.current = '';
      }, 400);
      return;
    }

    if (key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (scannerModeRef.current && scannerBufferRef.current) {
        appendBarcode(scannerBufferRef.current);
        scannerBufferRef.current = '';
        scannerModeRef.current = false;
        return;
      }
      appendBarcode(manualInput);
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
    appendBarcode(trimmed);
  }, [appendBarcode]);

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
    try {
      await track.applyConstraints({ advanced: [{ torch: next }] });
    } catch {}
    setTorchOn(next);
  };

  const tapToFocus = async () => {
    const track = streamRef.current?.getVideoTracks?.()[0];
    if (!track) return;
    try {
      const caps = track.getCapabilities?.();
      if (caps?.focusMode?.includes?.('single-shot')) {
        await track.applyConstraints({ advanced: [{ focusMode: 'single-shot' }] });
      }
    } catch {}
  };

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

      if (typeof codeReaderRef.current.decodeFromConstraints === 'function') {
        codeReaderRef.current.decodeFromConstraints(constraints, videoRef.current, (result) => {
          if (!result) return;
          const text = result.getText ? result.getText() : String(result?.text || '');
          if (text) handleCameraDetected(text);
        });
      } else {
        codeReaderRef.current.decodeFromVideoDevice(null, videoRef.current, (result) => {
          if (!result) return;
          const text = result.getText ? result.getText() : String(result?.text || '');
          if (text) handleCameraDetected(text);
        });
      }

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
          if (caps.focusMode?.includes?.('continuous')) {
            track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
          }
        } catch {}
      }, 300);
    } catch (error) {
      console.warn('Camera start failed', error);
    } finally {
      setIsStartingCamera(false);
    }
  }, [disabled, handleCameraDetected]);

  const stopCameraReader = useCallback(() => {
    try { codeReaderRef.current?.reset?.(); } catch {}
    try {
      const stream = streamRef.current || videoRef.current?.srcObject;
      if (stream?.getTracks) stream.getTracks().forEach((track) => { try { track.stop(); } catch {} });
    } catch {}
    if (videoRef.current) {
      try { videoRef.current.pause(); } catch {}
      try { videoRef.current.srcObject = null; } catch {}
    }
    streamRef.current = null;
    isReaderActiveRef.current = false;
  }, []);

  useEffect(() => {
    if (showCamera) startCamera();
    else stopCameraReader();
    return () => stopCameraReader();
  }, [showCamera, startCamera, stopCameraReader]);

  useEffect(() => {
    const handleHide = () => {
      if (!showCamera) return;
      stopCameraReader();
      setShowCamera(false);
    };
    window.addEventListener('pagehide', handleHide);
    document.addEventListener('visibilitychange', handleHide);
    return () => {
      window.removeEventListener('pagehide', handleHide);
      document.removeEventListener('visibilitychange', handleHide);
    };
  }, [showCamera, stopCameraReader]);

  useEffect(() => {
    if (isMobile || showCamera) return;
    try { hiddenInputRef.current?.focus(); } catch {}
  }, [isMobile, showCamera, receiptValues.length, rxValues.length]);

  const renderBarcodeGroup = (title, values, type) => (
    <div className="space-y-2 p-2 rounded-md border bg-card border-border dark:bg-slate-900/40 dark:border-slate-700">
      <div className="flex items-center justify-between">
        <Label className="text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</Label>
        <Badge className="bg-emerald-100 text-emerald-700 text-xs px-1.5 py-0 h-5">{values.length}</Badge>
      </div>
      {values.length > 0 ? (
        <div className="grid grid-cols-2 gap-2">
          {values.map((value, index) => (
            <div
              key={`${type}-${value}-${index}`}
              className="relative rounded-lg border bg-white dark:bg-slate-800 p-1 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-700"
              style={{ borderColor: 'var(--border-slate-200)' }}
              onClick={() => onSelectBarcode(value)}
              title={value}
            >
              <BarcodeThumb value={value} />
              <button
                type="button"
                className="absolute -top-1 -right-1 h-5 w-5 rounded-full bg-red-600 text-white flex items-center justify-center"
                onClick={(e) => { e.stopPropagation(); removeBarcode(type, index); }}
                aria-label="Remove barcode"
                disabled={disabled}
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-md border border-dashed p-4 text-xs text-slate-400 text-center">No {title.toLowerCase()} scanned yet</div>
      )}
    </div>
  );

  return (
    <div className="space-y-3" onClick={(e) => { if (!showCamera && e.target?.tagName !== 'INPUT') hiddenInputRef.current?.focus?.(); }}>
      <div className="flex items-center gap-2">
        <Barcode className="w-4 h-4 text-emerald-600" />
        <Label className="text-sm font-semibold text-slate-900 dark:text-slate-100">Barcodes</Label>
        {allValues.length > 0 && <Badge className="bg-emerald-100 text-emerald-700 text-xs px-1.5 py-0 h-5">{allValues.length}</Badge>}
      </div>

      <div className="flex gap-2 items-center">
        <Input
          ref={inputRef}
          type="text"
          value={manualInput}
          onChange={(e) => { if (!scannerModeRef.current) setManualInput(e.target.value); }}
          onKeyDown={handleInputKeyDown}
          onFocus={() => hiddenInputRef.current?.blur?.()}
          placeholder="Scan or type barcode value..."
          className="flex-1 h-9 text-sm font-mono"
          disabled={disabled}
          autoComplete="off"
        />
        <input
          ref={hiddenInputRef}
          type="text"
          className="sr-only absolute -left-[9999px] w-0 h-0 opacity-0"
          onKeyDown={handleInputKeyDown}
          onChange={() => {}}
          aria-hidden="true"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          inputMode="none"
        />
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="h-9 px-3 flex-shrink-0 sm:hidden"
          onClick={() => setShowCamera(true)}
          disabled={disabled}
          title="Scan with camera"
        >
          <Camera className="w-4 h-4" />
        </Button>
      </div>

      <p className="text-xs text-slate-400">Use one scan field and the app will sort each barcode into Receipt or Rx automatically.</p>

      {showCamera && (
        <div className="fixed inset-0 z-[10030] bg-black/50 backdrop-blur-sm">
          <div className="relative w-screen mx-auto mt-[10vh] px-0">
            <div onClick={tapToFocus} className={`relative mx-auto w-screen aspect-video border-2 ${flashHit ? 'border-emerald-400' : 'border-white/80'} rounded-md overflow-hidden bg-black/20`}>
              <video ref={videoRef} className="w-full h-full object-cover" playsInline autoPlay muted />
              <div className="pointer-events-none absolute inset-0">
                <div className="absolute top-1/2 left-0 right-0 h-[2px] bg-white/50" />
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className="px-2 py-0.5 text-[10px] rounded bg-black/50 text-white/80">Hold label so bars run left→right and fill the frame</span>
                </div>
                <div className="absolute -top-1 -left-1 w-6 h-6 border-t-4 border-l-4 border-emerald-400 rounded-tl" />
                <div className="absolute -top-1 -right-1 w-6 h-6 border-t-4 border-r-4 border-emerald-400 rounded-tr" />
                <div className="absolute -bottom-1 -left-1 w-6 h-6 border-b-4 border-l-4 border-emerald-400 rounded-bl" />
                <div className="absolute -bottom-1 -right-1 w-6 h-6 border-b-4 border-r-4 border-emerald-400 rounded-br" />
              </div>
            </div>
            <div className="mt-3 flex items-center justify-between text-white/90">
              <div className="flex items-center gap-2">
                <div className="text-sm">{allValues.length} scanned</div>
                {canZoom && (
                  <div className="ml-1 flex items-center gap-1">
                    <Button variant="secondary" size="sm" onClick={() => adjustZoom(-0.5)} title="Zoom out"><Minus className="w-4 h-4" /></Button>
                    <Button variant="secondary" size="sm" onClick={() => adjustZoom(0.5)} title="Zoom in"><ZoomIn className="w-4 h-4" /></Button>
                  </div>
                )}
                {hasTorch && (
                  <Button variant="secondary" size="sm" onClick={toggleTorch} title="Toggle torch" className={torchOn ? 'bg-emerald-600 hover:bg-emerald-700 text-white' : ''}>
                    <Sun className="w-4 h-4 mr-1" /> {torchOn ? 'Torch On' : 'Torch'}
                  </Button>
                )}
              </div>
              <Button variant="secondary" size="sm" onClick={() => { stopCameraReader(); setShowCamera(false); }}>
                <X className="w-4 h-4 mr-1" /> Close
              </Button>
            </div>
            <div className="mt-2 text-center text-xs text-white/70">
              {isStartingCamera ? 'Starting camera...' : (flashHit ? 'Captured!' : 'Point camera at a barcode')}
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {renderBarcodeGroup('Receipt Barcodes', receiptValues, 'receipt')}
        {renderBarcodeGroup('Rx Barcodes', rxValues, 'rx')}
      </div>
    </div>
  )
}