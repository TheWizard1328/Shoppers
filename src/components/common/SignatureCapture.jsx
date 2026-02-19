import React, { useRef, useState, useEffect } from 'react';
import ReactDOM from 'react-dom';
import { Button } from '@/components/ui/button';
import { X, RotateCcw, Check, Loader2 } from 'lucide-react';

export default function SignatureCapture({ onSave, onCancel, customerName = '', isSaved = false }) {
  const canvasRef = useRef(null);
  const contextRef = useRef(null); // Use ref, not state, to avoid stale closure bugs
  const isDrawingRef = useRef(false);
  const [hasSignature, setHasSignature] = useState(false);
  const [showClear, setShowClear] = useState(isSaved);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const setupCanvas = () => {
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * 2;
      canvas.height = rect.height * 2;
      const ctx = canvas.getContext('2d');
      ctx.scale(2, 2);
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      contextRef.current = ctx;
      console.log('📝 [SignatureCapture] Canvas ready, size:', rect.width, 'x', rect.height);
    };

    setupCanvas();
    window.addEventListener('resize', setupCanvas);
    return () => window.removeEventListener('resize', setupCanvas);
  }, []);

  const getCoords = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    if (e.touches && e.touches.length > 0) {
      return { x: e.touches[0].clientX - rect.left, y: e.touches[0].clientY - rect.top };
    }
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const startDrawing = (e) => {
    const ctx = contextRef.current;
    if (!ctx) {
      console.warn('⚠️ [SignatureCapture] Context not ready');
      return;
    }
    isDrawingRef.current = true;
    setHasSignature(true);
    const { x, y } = getCoords(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
  };

  const draw = (e) => {
    if (!isDrawingRef.current || !contextRef.current) return;
    e.preventDefault();
    const { x, y } = getCoords(e);
    contextRef.current.lineTo(x, y);
    contextRef.current.stroke();
  };

  const stopDrawing = () => {
    isDrawingRef.current = false;
  };

  const clearSignature = () => {
    const ctx = contextRef.current;
    if (!ctx) return;
    const canvas = canvasRef.current;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setHasSignature(false);
    setShowClear(false);
    console.log('🗑️ [SignatureCapture] Cleared');
  };

  const handleSave = async () => {
    console.log('📝 [SignatureCapture] Saving...');
    if (isSaving) {
      console.log('⏸️ [SignatureCapture] Already saving - ignoring');
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas || !hasSignature) {
      console.warn('⚠️ [SignatureCapture] No signature to save');
      return;
    }

    setIsSaving(true);

    try {
      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob(
          (blob) => {
            if (!blob) {
              reject(new Error('Failed to create blob'));
            } else {
              resolve(blob);
            }
          },
          'image/png',
          0.95
        );
      });

      console.log('📤 [SignatureCapture] Uploading signature blob:', blob.size, 'bytes');
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
    <div className="fixed inset-0 z-[50000] bg-black flex items-center justify-center">
      <div className="w-full h-full flex flex-col" style={{ background: 'var(--bg-white)' }}>
         <div className="border-b px-4 py-3 flex items-center justify-between" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
           <div className="flex items-center gap-3">
             <h3 className="text-base font-semibold" style={{ color: 'var(--text-slate-900)' }}>Customer Signature</h3>
             {customerName && <span className="text-sm" style={{ color: 'var(--text-slate-600)' }}>— {customerName}</span>}
           </div>
           <Button 
             variant="ghost" 
             size="icon" 
             onClick={onCancel}
             disabled={isSaving}
           >
             <X className="w-5 h-5" />
           </Button>
         </div>

         <div className="flex-1 p-3 overflow-hidden" style={{ background: 'var(--bg-slate-50)' }}>
           <div className="w-full h-full border-2 rounded-lg relative" style={{ borderColor: 'var(--border-slate-300)', background: 'var(--bg-white)' }}>
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
             <div className="absolute top-4 left-4 text-lg pointer-events-none" style={{ color: 'var(--text-slate-400)' }}>
               Sign here with your finger
             </div>
           </div>
         </div>

         <div className="border-t px-4 py-3 flex gap-2 justify-end" style={{ borderColor: 'var(--border-slate-200)', background: 'var(--bg-white)' }}>
           {showClear ? (
             <>
               <Button 
                 variant="outline" 
                 size="sm" 
                 onClick={clearSignature}
                 disabled={isSaving}
               >
                 <RotateCcw className="w-4 h-4 mr-2" />
                 Clear
               </Button>
               <Button 
                 size="sm" 
                 onClick={handleSave}
                 className="bg-emerald-600 hover:bg-emerald-700"
                 disabled={!hasSignature || isSaving}
               >
                 {isSaving ? (
                   <>
                     <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                     Updating...
                   </>
                 ) : (
                   <>
                     <Check className="w-4 h-4 mr-2" />
                     Update
                   </>
                 )}
               </Button>
             </>
           ) : (
             <>
               <Button 
                 variant="outline" 
                 size="sm" 
                 onClick={onCancel}
                 disabled={isSaving}
               >
                 Cancel
               </Button>
               <Button 
                 size="sm" 
                 onClick={handleSave} 
                 disabled={!hasSignature || isSaving}
                 className="bg-emerald-600 hover:bg-emerald-700"
               >
                 {isSaving ? (
                   <>
                     <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                     Saving...
                   </>
                 ) : (
                   <>
                     <Check className="w-4 h-4 mr-2" />
                     Save
                   </>
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