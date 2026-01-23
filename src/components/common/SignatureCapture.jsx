import React, { useRef, useState, useEffect } from 'react';
import ReactDOM from 'react-dom';
import { Button } from '@/components/ui/button';
import { X, RotateCcw, Check, Loader2 } from 'lucide-react';

export default function SignatureCapture({ onSave, onCancel, customerName = '', isSaved = false }) {
  const canvasRef = useRef(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [hasSignature, setHasSignature] = useState(false);
  const [context, setContext] = useState(null);
  const [showClear, setShowClear] = useState(isSaved);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    setContext(ctx);
    console.log('📝 [SignatureCapture] Canvas ready');

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
    if (!context) {
      console.warn('⚠️ [SignatureCapture] Context not ready');
      return;
    }
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
      <div className="bg-white w-full h-full flex flex-col">
         <div className="border-b px-4 py-3 flex items-center justify-between bg-slate-50">
           <div className="flex items-center gap-3">
             <h3 className="text-base font-semibold text-slate-900">Customer Signature</h3>
             {customerName && <span className="text-sm text-slate-600">— {customerName}</span>}
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
             <div className="absolute top-4 left-4 text-lg text-slate-400 pointer-events-none">
               Sign here with your finger
             </div>
           </div>
         </div>

         <div className="border-t px-4 py-3 bg-white flex gap-2 justify-end">
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