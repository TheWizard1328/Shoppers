import React, { useRef, useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { X, RotateCcw, Check } from 'lucide-react';

export default function SignatureCapture({ onSave, onCancel, customerName = '' }) {
  const canvasRef = useRef(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [hasSignature, setHasSignature] = useState(false);
  const [context, setContext] = useState(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    setContext(ctx);

    // Set canvas size
    const resizeCanvas = () => {
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * 2;
      canvas.height = rect.height * 2;
      ctx.scale(2, 2);
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
    };

    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    return () => window.removeEventListener('resize', resizeCanvas);
  }, []);

  const startDrawing = (e) => {
    if (!context) return;
    setIsDrawing(true);
    setHasSignature(true);

    const rect = canvasRef.current.getBoundingClientRect();
    const x = (e.clientX || e.touches[0].clientX) - rect.left;
    const y = (e.clientY || e.touches[0].clientY) - rect.top;

    context.beginPath();
    context.moveTo(x, y);
  };

  const draw = (e) => {
    if (!isDrawing || !context) return;
    e.preventDefault();

    const rect = canvasRef.current.getBoundingClientRect();
    const x = (e.clientX || e.touches[0].clientX) - rect.left;
    const y = (e.clientY || e.touches[0].clientY) - rect.top;

    context.lineTo(x, y);
    context.stroke();
  };

  const stopDrawing = () => {
    setIsDrawing(false);
  };

  const clearSignature = () => {
    if (!context) return;
    const canvas = canvasRef.current;
    context.clearRect(0, 0, canvas.width, canvas.height);
    setHasSignature(false);
  };

  const handleSave = () => {
    const canvas = canvasRef.current;
    canvas.toBlob((blob) => {
      onSave(blob);
    }, 'image/png');
  };

  return (
    <div className="fixed inset-0 z-[99999] bg-black flex items-center justify-center">
      <div className="bg-white w-full h-full flex flex-col">
        {/* Header - compact for landscape */}
        <div className="border-b px-4 py-2 flex items-center justify-between bg-slate-50 flex-shrink-0">
          <div className="flex items-center gap-3">
            <h3 className="text-base font-semibold text-slate-900">Customer Signature</h3>
            {customerName && <span className="text-sm text-slate-600">— {customerName}</span>}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={clearSignature} disabled={!hasSignature}>
              <RotateCcw className="w-4 h-4 mr-2" />
              Clear
            </Button>
            <Button size="sm" onClick={handleSave} disabled={!hasSignature} className="bg-emerald-600 hover:bg-emerald-700">
              <Check className="w-4 h-4 mr-2" />
              Save
            </Button>
            <Button variant="ghost" size="icon" onClick={onCancel}>
              <X className="w-5 h-5" />
            </Button>
          </div>
        </div>

        {/* Signature Canvas - Full screen */}
        <div className="flex-1 p-3 bg-slate-50 overflow-hidden">
          <div className="w-full h-full border-2 border-slate-300 rounded-lg bg-white relative">
            <canvas
              ref={canvasRef}
              onMouseDown={startDrawing}
              onMouseMove={draw}
              onMouseUp={stopDrawing}
              onMouseLeave={stopDrawing}
              onTouchStart={startDrawing}
              onTouchMove={draw}
              onTouchEnd={stopDrawing}
              className="w-full h-full touch-none cursor-crosshair"
              style={{ touchAction: 'none' }}
            />
            <div className="absolute top-4 left-4 text-lg text-slate-400 pointer-events-none font-light">
              Sign here with your finger
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}