import React, { useRef, useState, useEffect, useCallback } from 'react';
import ReactDOM from 'react-dom';
import { Button } from '@/components/ui/button';
import { X, RotateCcw, Check, Loader2 } from 'lucide-react';

export default function SignatureCapture({ onSave, onCancel, customerName = '', isSaved = false }) {
  const canvasRef = useRef(null);
  const isDrawingRef = useRef(false);
  const [hasSignature, setHasSignature] = useState(false);
  const [showClear, setShowClear] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const setupCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    canvas.width = Math.round(rect.width);
    canvas.height = Math.round(rect.height);
    const ctx = canvas.getContext('2d');
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }, []);

  useEffect(() => {
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
      return { x: e.touches[0].clientX - rect.left, y: e.touches[0].clientY - rect.top };
    }
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
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
    if (!isDrawingRef.current) return;
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
  };

  const handleSave = async () => {
    if (isSaving) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    setIsSaving(true);
    try {
      const rotated = document.createElement('canvas');
      rotated.width = canvas.height;
      rotated.height = canvas.width;
      const rCtx = rotated.getContext('2d');
      rCtx.translate(canvas.height, 0);
      rCtx.rotate(Math.PI / 2);
      rCtx.drawImage(canvas, 0, 0);

      const blob = await new Promise((resolve, reject) => {
        rotated.toBlob((result) => {
          if (!result || !result.size) {
            reject(new Error('Signature blob is empty'));
            return;
          }
          resolve(result);
        }, 'image/png');
      });

      await onSave(blob);
      setShowClear(true);
    } catch (error) {
      console.error('❌ [SignatureCapture] Save error:', error);
      throw error;
    } finally {
      setIsSaving(false);
    }
  };

  return ReactDOM.createPortal(
    <div
      className="fixed z-[50000] flex items-center justify-center left-0 right-0 top-[calc(env(safe-area-inset-top,0px)+57px)] md:top-0 bottom-[var(--bottom-nav-height,0px)] md:bottom-0"
      style={{ background: 'rgba(0,0,0,0.85)' }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="w-full h-full md:max-h-[80vh] md:max-w-2xl md:rounded-xl flex flex-col overflow-hidden shadow-2xl" style={{ background: 'var(--bg-white)' }}>
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
              <div className="absolute inset-0 flex items-center justify-start pl-[50px] pointer-events-none">
                <span className="text-2xl select-none inline-block" style={{ color: 'var(--text-slate-300)', transform: 'rotate(-90deg)' }}>
                  ✍️ Sign here
                </span>
              </div>
            )}
          </div>
        </div>

        <div
          className="border-t px-4 py-3 flex gap-2 justify-between items-center flex-shrink-0"
          style={{ borderColor: 'var(--border-slate-200)', background: 'var(--bg-white)' }}
        >
          <div>
            {isSaving && (
              <span className="text-sm text-slate-500 flex items-center gap-1">
                <Loader2 className="w-3 h-3 animate-spin" /> Saving...
              </span>
            )}
          </div>
          <div className="flex gap-2">
            {showClear ? (
              <>
                <Button variant="outline" size="sm" onClick={clearSignature} disabled={isSaving}>
                  <RotateCcw className="w-4 h-4 mr-2" />
                  Redo
                </Button>
                <Button size="sm" onClick={onCancel} className="bg-emerald-600 hover:bg-emerald-700">
                  <Check className="w-4 h-4 mr-2" />Close
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
                <Button size="sm" onClick={handleSave} disabled={!hasSignature || isSaving} className="bg-emerald-600 hover:bg-emerald-700">
                  <Check className="w-4 h-4 mr-2" />Save
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}