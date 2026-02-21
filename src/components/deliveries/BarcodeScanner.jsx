import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { X, Camera, Barcode, Plus, Trash2, ZoomIn } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import JsBarcode from 'jsbarcode';

// Renders a single barcode as SVG using JsBarcode
function BarcodeDisplay({ value, onDelete }) {
  const svgRef = useRef(null);

  useEffect(() => {
    if (!svgRef.current || !value) return;
    try {
      JsBarcode(svgRef.current, value, {
        format: 'CODE128',
        lineColor: '#000',
        width: 2,
        height: 60,
        displayValue: true,
        fontSize: 12,
        margin: 8,
        background: '#ffffff'
      });
    } catch (e) {
      // If CODE128 fails try auto
      try {
        JsBarcode(svgRef.current, value, {
          format: 'auto',
          lineColor: '#000',
          width: 2,
          height: 60,
          displayValue: true,
          fontSize: 12,
          margin: 8,
          background: '#ffffff'
        });
      } catch (e2) {
        console.warn('BarcodeDisplay: could not render barcode for value:', value);
      }
    }
  }, [value]);

  return (
    <div className="flex items-center gap-2 p-2 rounded-lg border bg-white" style={{ borderColor: 'var(--border-slate-200)' }}>
      <div className="flex-1 min-w-0">
        <svg ref={svgRef} className="w-full" />
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 w-7 p-0 flex-shrink-0 text-red-400 hover:text-red-600 hover:bg-red-50"
        onClick={onDelete}
        title="Remove barcode"
      >
        <Trash2 className="w-3.5 h-3.5" />
      </Button>
    </div>
  );
}

// Stops all tracks on a video element and clears srcObject
function stopVideoStream(videoEl) {
  if (!videoEl) return;
  try {
    if (videoEl.srcObject) {
      videoEl.srcObject.getTracks().forEach(track => track.stop());
      videoEl.srcObject = null;
    }
  } catch {}
}

// Camera scanner modal using @zxing
function BarcodeCameraModal({ onDetected, onClose }) {
  const videoRef = useRef(null);
  const [error, setError] = useState(null);
  const codeReaderRef = useRef(null);
  const detectedRef = useRef(false);

  const stopReader = useCallback(() => {
    if (codeReaderRef.current) {
      try { codeReaderRef.current.reset(); } catch {}
      codeReaderRef.current = null;
    }
    stopVideoStream(videoRef.current);
  }, []);

  useEffect(() => {
    let active = true;

    const startScan = async () => {
      try {
        const { BrowserMultiFormatReader } = await import('@zxing/browser');
        const codeReader = new BrowserMultiFormatReader();
        codeReaderRef.current = codeReader;

        // List devices and prefer back camera
        const devices = await BrowserMultiFormatReader.listVideoInputDevices();
        const backCamera = devices.find(d => /back|rear|environment/i.test(d.label));
        const deviceId = backCamera?.deviceId || (devices.length > 0 ? devices[devices.length - 1].deviceId : undefined);

        // decodeFromVideoDevice is the canonical working API
        await codeReader.decodeFromVideoDevice(deviceId, videoRef.current, (result, err) => {
          if (!active || detectedRef.current) return;
          if (result) {
            detectedRef.current = true;
            const text = result.getText();
            stopReader();
            onDetected(text);
          }
          // err is NotFoundException on every empty frame — that's normal, ignore it
        });
      } catch (e) {
        if (active) setError(e.message || 'Camera access failed');
      }
    };

    startScan();

    return () => {
      active = false;
      stopReader();
    };
  }, []);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[10050] bg-black/90 flex flex-col items-center justify-center p-4"
    >
      <div className="w-full max-w-sm bg-white rounded-xl overflow-hidden shadow-2xl">
        <div className="flex items-center justify-between p-3 border-b bg-slate-50">
          <div className="flex items-center gap-2">
            <Camera className="w-4 h-4 text-emerald-600" />
            <span className="font-semibold text-sm">Scan Barcode</span>
          </div>
          <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
            <X className="w-4 h-4" />
          </Button>
        </div>

        <div className="relative bg-black" style={{ height: '280px' }}>
          <video ref={videoRef} className="w-full h-full object-cover" autoPlay playsInline muted />
          {/* Targeting overlay */}
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="relative w-64 h-24 border-2 border-emerald-400 rounded-md opacity-90">
              {/* Corner markers */}
              <div className="absolute top-0 left-0 w-4 h-4 border-t-4 border-l-4 border-emerald-400 rounded-tl" />
              <div className="absolute top-0 right-0 w-4 h-4 border-t-4 border-r-4 border-emerald-400 rounded-tr" />
              <div className="absolute bottom-0 left-0 w-4 h-4 border-b-4 border-l-4 border-emerald-400 rounded-bl" />
              <div className="absolute bottom-0 right-0 w-4 h-4 border-b-4 border-r-4 border-emerald-400 rounded-br" />
              {/* Animated scan line */}
              <div
                className="absolute left-1 right-1 h-0.5 bg-emerald-400 rounded-full shadow-[0_0_6px_2px_rgba(52,211,153,0.7)]"
                style={{ animation: 'scanline 1.8s ease-in-out infinite', top: '50%' }}
              />
            </div>
          </div>
          <style>{`
            @keyframes scanline {
              0%   { transform: translateY(-22px); opacity: 1; }
              50%  { transform: translateY(22px);  opacity: 1; }
              100% { transform: translateY(-22px); opacity: 1; }
            }
          `}</style>
          {!error && (
            <div className="absolute bottom-2 left-0 right-0 text-center">
              <span className="text-xs text-white bg-black/50 px-2 py-1 rounded-full">
                Point camera at barcode
              </span>
            </div>
          )}
        </div>

        {error && (
          <div className="p-3 bg-red-50 text-red-700 text-sm text-center">
            {error}
          </div>
        )}

        <div className="p-3 text-center">
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </motion.div>
  );
}

export default function BarcodeScanner({ barcodeValues = [], onChange, disabled = false }) {
  const [manualInput, setManualInput] = useState('');
  const [showCamera, setShowCamera] = useState(false);
  const [expandedIndex, setExpandedIndex] = useState(null);
  const inputRef = useRef(null);

  const addBarcode = useCallback((value) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    // Avoid duplicates
    if (barcodeValues.includes(trimmed)) {
      setManualInput('');
      return;
    }
    onChange([...barcodeValues, trimmed]);
    setManualInput('');
  }, [barcodeValues, onChange]);

  const removeBarcode = useCallback((index) => {
    const updated = barcodeValues.filter((_, i) => i !== index);
    onChange(updated);
    if (expandedIndex === index) setExpandedIndex(null);
  }, [barcodeValues, onChange, expandedIndex]);

  const handleInputKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      addBarcode(manualInput);
    }
  };

  const handleCameraDetected = useCallback((value) => {
    setShowCamera(false);
    addBarcode(value);
  }, [addBarcode]);

  // Auto-focus input after adding
  const handleAdd = () => {
    addBarcode(manualInput);
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Barcode className="w-4 h-4 text-emerald-600" />
        <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>
          Package Barcodes
        </Label>
        {barcodeValues.length > 0 && (
          <Badge className="bg-emerald-100 text-emerald-700 text-xs px-1.5 py-0 h-5">
            {barcodeValues.length}
          </Badge>
        )}
      </div>

      {/* Input row */}
      <div className="flex gap-2">
        <Input
          ref={inputRef}
          type="text"
          value={manualInput}
          onChange={(e) => setManualInput(e.target.value)}
          onKeyDown={handleInputKeyDown}
          placeholder="Scan or type barcode value..."
          className="flex-1 h-9 text-sm font-mono"
          disabled={disabled}
          autoComplete="off"
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-9 px-3 flex-shrink-0"
          onClick={handleAdd}
          disabled={disabled || !manualInput.trim()}
          title="Add barcode"
        >
          <Plus className="w-4 h-4" />
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-9 w-9 p-0 flex-shrink-0"
          onClick={() => setShowCamera(true)}
          disabled={disabled}
          title="Scan with camera"
        >
          <Camera className="w-4 h-4" />
        </Button>
      </div>

      <p className="text-xs text-slate-400">
        Use a hand scanner directly into the field, or tap the camera icon to scan with device camera.
      </p>

      {/* Barcode list */}
      {barcodeValues.length > 0 && (
        <div className="space-y-2">
          {barcodeValues.map((val, idx) => (
            <div key={idx}>
              {/* Collapsed row */}
              <div
                className={`flex items-center gap-2 p-2 rounded-lg border cursor-pointer transition-colors ${expandedIndex === idx ? 'border-emerald-300 bg-emerald-50' : 'bg-white hover:bg-slate-50'}`}
                style={{ borderColor: expandedIndex === idx ? undefined : 'var(--border-slate-200)' }}
                onClick={() => setExpandedIndex(expandedIndex === idx ? null : idx)}
              >
                <Barcode className="w-4 h-4 text-slate-400 flex-shrink-0" />
                <span className="flex-1 text-xs font-mono truncate text-slate-700">{val}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0 flex-shrink-0 text-slate-400 hover:text-emerald-600"
                  onClick={(e) => { e.stopPropagation(); setExpandedIndex(expandedIndex === idx ? null : idx); }}
                  title="Show barcode"
                >
                  <ZoomIn className="w-3.5 h-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0 flex-shrink-0 text-red-400 hover:text-red-600 hover:bg-red-50"
                  onClick={(e) => { e.stopPropagation(); removeBarcode(idx); }}
                  title="Remove"
                  disabled={disabled}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>

              {/* Expanded barcode display */}
              <AnimatePresence>
                {expandedIndex === idx && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    className="overflow-hidden"
                  >
                    <div className="mt-1 p-2 bg-white rounded-lg border border-emerald-200">
                      <BarcodeDisplay value={val} onDelete={() => removeBarcode(idx)} />
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          ))}
        </div>
      )}

      {/* Camera modal */}
      <AnimatePresence>
        {showCamera && (
          <BarcodeCameraModal
            onDetected={handleCameraDetected}
            onClose={() => setShowCamera(false)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}