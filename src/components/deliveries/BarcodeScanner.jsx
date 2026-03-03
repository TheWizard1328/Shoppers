import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { X, Camera, Barcode, Plus, Trash2, ZoomIn, CheckCircle2, Loader2, AlertCircle } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
// JsBarcode removed (package resolution issue)
import { processBarcode } from '@/functions/processBarcode';

// Barcode preview (text fallback - JsBarcode removed)
function BarcodeDisplay({ value, onDelete }) {
  return (
    <div className="flex items-center gap-2 p-2 rounded-lg border bg-white" style={{ borderColor: 'var(--border-slate-200)' }}>
      <div className="flex-1 min-w-0">
        <div className="w-full h-16 flex items-center justify-center bg-slate-50 border rounded">
          <span className="font-mono text-sm text-slate-700 truncate">{value}</span>
        </div>
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
    // Don't close camera — continuous scanning mode. Just add the barcode.
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


    </div>
  );
}