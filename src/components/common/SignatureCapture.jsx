import React, { useRef, useState, useEffect, useCallback } from 'react';
import ReactDOM from 'react-dom';
import { Button } from '@/components/ui/button';
import { X, RotateCcw, Check, Loader2 } from 'lucide-react';

export default function SignatureCapture({ onSave, onCancel, customerName = '', isSaved = false }) {
  const canvasRef = useRef(null);
  const isDrawingRef = useRef(false);
  const [hasSignature, setHasSignature] = useState(false);
  const [showClear, setShowClear] = useState(isSaved);
  const [isSaving, setIsSaving] = useState(false);

  // Setup canvas - NO DPR scaling to avoid coordinate mismatch issues
  const setupCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      console.warn('⚠️ [SignatureCapture] Canvas has zero dimensions, skipping setup');
      return;
    }

    // Set canvas resolution exactly equal to CSS size (no DPR scaling)
    // This ensures mouse/touch coordinates match canvas coordinates 1:1
    canvas.width = Math.round(rect.width);
    canvas.height = Math.round(rect.height);

    const ctx = canvas.getContext('2d');
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    console.log('📝 [SignatureCapture] Canvas setup:', canvas.width, 'x', canvas.height);
  }, []);

  useEffect(() => {
    // Try immediately, then retry with delays to handle portal rendering
    setupCanvas();
    const t1 = setTimeout(setupCanvas, 100);
    const t2 = setTimeout(setupCanvas, 300);
    window.addEventListener('resize', setupCanvas);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      window.removeEventListener('resize', setupCanvas);
    };
  }, [setupCanvas]);

  const getCoords = (e) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    if (e.touches && e.touches.length > 0) {
      return {
        x: e.touches[0].clientX - rect.left,
        y: e.touches[0].clientY - rect.top
      };
    }
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top
    };
  };

  const startDrawing = (e) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    isDrawingRef.current = true;
    setHasSignature(true);
    const { x, y } = getCoords(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
    console.log('✏️ [SignatureCapture] startDrawing at', x, y);
  };

  const draw = (e) => {
    if (!isDrawingRef.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    e.preventDefault();
    const { x, y } = getCoords(e);
    ctx.lineTo(x, y);
    ctx.stroke();
  };

  const stopDrawing = () => {
    isDrawingRef.current = false;
  };

  const clearSignature = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    setHasSignature(false);
    setShowClear(false);
    console.log('🗑️ [SignatureCapture] Cleared');
  };

  const handleSave = async () => {
    if (isSaving) return;

    const canvas = canvasRef.current;
    if (!canvas) {
      console.warn('⚠️ [SignatureCapture] No canvas ref');
      return;
    }
    if (!hasSignature) {
      console.warn('⚠️ [SignatureCapture] No signature drawn');
      return;
    }

    console.log('📝 [SignatureCapture] Saving... canvas size:', canvas.width, 'x', canvas.height);
    setIsSaving(true);

    try {
      const blob = await new Promise((resolve, reject) => {
        try {
          canvas.toBlob(
            (b) => {
              if (!b) {
                reject(new Error('canvas.toBlob returned null - canvas may be empty or tainted'));
              } else {
                console.log('📦 [SignatureCapture] Blob created:', b.size, 'bytes, type:', b.type);
                resolve(b);
              }
            },
            'image/png'
          );
        } catch (err) {
          reject(err);
        }
      });

      if (blob.size < 100) {
        throw new Error('Blob is suspiciously small (' + blob.size + ' bytes) - signature may not have been captured');
      }

      console.log('📤 [SignatureCapture] Uploading blob:', blob.size, 'bytes');
      await onSave(blob);

      setShowClear(true);
      console.log('✅ [SignatureCapture] Saved successfully');
    } catch (error) {
      console.error('❌ [SignatureCapture] Save error:', error);
      throw error;
    } finally {
      setIsSaving(false);
    }
  };

  return ReactDOM.createPortal(
    <div
      className="fixed inset-0 z-[50000] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.85)' }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="w-full h-full flex flex-col" style={{ background: 'var(--bg-white)' }}>
        {/* Header */}
        <div
          className="border-b px-4 py-3 flex items-center justify-between flex-shrink-0"
          style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}
        >
          <div className="flex items-center gap-3">
            <h3 className="text-base font-semibold" style={{ color: 'var(--text-slate-900)' }}>
              Customer Signature
            </h3>
            {customerName && (
              <span className="text-sm" style={{ color: 'var(--text-slate-600)' }}>
                — {customerName}
              </span>
            )}
          </div>
          <Button variant="ghost" size="icon" onClick={onCancel} disabled={isSaving}>
            <X className="w-5 h-5" />
          </Button>
        </div>

        {/* Canvas Area */}
        <div className="flex-1 p-3 overflow-hidden" style={{ background: 'var(--bg-slate-100)' }}>
          <div
            className="w-full h-full border-2 rounded-lg relative overflow-hidden"
            style={{ borderColor: 'var(--border-slate-300)', background: '#ffffff' }}
          >
            <canvas
              ref={canvasRef}
              onMouseDown={startDrawing}
              onMouseMove={draw}
              onMouseUp={stopDrawing}
              onMouseLeave={stopDrawing}
              onTouchStart={startDrawing}
              onTouchMove={draw}
              onTouchEnd={stopDrawing}
              onTouchCancel={stopDrawing}
              className="w-full h-full touch-none cursor-crosshair block"
              style={{ touchAction: 'none', display: 'block' }}
            />
            {!hasSignature && (
              <div
                className="absolute inset-0 flex items-center justify-center pointer-events-none"
              >
                <span className="text-2xl select-none" style={{ color: 'var(--text-slate-300)' }}>
                  ✍️ Sign here
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div
          className="border-t px-4 py-3 flex gap-2 justify-end flex-shrink-0"
          style={{ borderColor: 'var(--border-slate-200)', background: 'var(--bg-white)' }}
        >
          {showClear ? (
            <>
              <Button variant="outline" size="sm" onClick={clearSignature} disabled={isSaving}>
                <RotateCcw className="w-4 h-4 mr-2" />
                Clear & Redo
              </Button>
              <Button
                size="sm"
                onClick={handleSave}
                className="bg-emerald-600 hover:bg-emerald-700"
                disabled={!hasSignature || isSaving}
              >
                {isSaving ? (
                  <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Updating...</>
                ) : (
                  <><Check className="w-4 h-4 mr-2" />Update</>
                )}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={clearSignature} disabled={!hasSignature || isSaving}>
                <RotateCcw className="w-4 h-4 mr-2" />
                Clear
              </Button>
              <Button variant="outline" size="sm" onClick={onCancel} disabled={isSaving}>
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleSave}
                disabled={!hasSignature || isSaving}
                className="bg-emerald-600 hover:bg-emerald-700"
              >
                {isSaving ? (
                  <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Saving...</>
                ) : (
                  <><Check className="w-4 h-4 mr-2" />Save Signature</>
                )}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}