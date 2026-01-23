import React, { useRef, useState, useCallback, useEffect } from 'react';
import ReactDOM from 'react-dom';
import { Button } from '@/components/ui/button';
import { X, Camera, Trash2, Check, Loader2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

export default function PhotoCapture({ onSave, onCancel, maxPhotos = 3 }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [capturedPhotos, setCapturedPhotos] = useState([]);
  const [error, setError] = useState('');
  const [isCapturing, setIsCapturing] = useState(false);

  const startCamera = useCallback(async () => {
    console.log('📷 [PhotoCapture] Starting camera...');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' }
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play();
        setIsCameraActive(true);
        setError('');
        console.log('✅ [PhotoCapture] Camera started successfully');
      }
    } catch (err) {
      console.error('❌ [PhotoCapture] Camera error:', err);
      setError('Could not access camera. Please check permissions.');
    }
  }, []);

  const stopCamera = useCallback(() => {
    if (videoRef.current?.srcObject) {
      videoRef.current.srcObject.getTracks().forEach(track => track.stop());
      videoRef.current.srcObject = null;
    }
    setIsCameraActive(false);
    console.log('🛑 [PhotoCapture] Camera stopped');
  }, []);

  const capturePhoto = useCallback(() => {
    console.log('📷 [PhotoCapture] Capturing photo...');
    if (!videoRef.current || !canvasRef.current || isCapturing) {
      console.warn('⚠️ [PhotoCapture] Cannot capture - video/canvas not ready or already capturing');
      return;
    }
    
    setIsCapturing(true);

    const video = videoRef.current;
    const canvas = canvasRef.current;
    
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0);

    canvas.toBlob((blob) => {
      if (blob) {
        const url = URL.createObjectURL(blob);
        setCapturedPhotos(prev => {
          const newPhotos = [...prev, { blob, url }];
          if (newPhotos.length >= maxPhotos) {
            stopCamera();
          }
          return newPhotos;
        });
        console.log('✅ [PhotoCapture] Photo captured');
      } else {
        setError('Failed to create photo');
        console.error('❌ [PhotoCapture] Blob creation failed');
      }
      setIsCapturing(false);
    }, 'image/jpeg', 0.8);
  }, [maxPhotos, stopCamera, isCapturing]);

  const removePhoto = (index) => {
    setCapturedPhotos(prev => {
      const newPhotos = [...prev];
      URL.revokeObjectURL(newPhotos[index].url);
      newPhotos.splice(index, 1);
      if (!isCameraActive && newPhotos.length < maxPhotos) {
        startCamera();
      }
      return newPhotos;
    });
    console.log(`🗑️ [PhotoCapture] Photo ${index + 1} removed`);
  };

  const handleSave = async () => {
    console.log('📷 [PhotoCapture] Saving photos...');
    if (capturedPhotos.length === 0) {
      console.warn('⚠️ [PhotoCapture] No photos to save');
      return;
    }
    
    setIsCapturing(true);
    try {
      await onSave(capturedPhotos.map(p => p.blob));
      capturedPhotos.forEach(p => URL.revokeObjectURL(p.url));
      console.log('✅ [PhotoCapture] Photos saved');
    } catch (err) {
      console.error('❌ [PhotoCapture] Save failed:', err);
      setError('Failed to save photos: ' + err.message);
    } finally {
      setIsCapturing(false);
    }
  };

  const handleCancel = () => {
    console.log('↩️ [PhotoCapture] Cancelled');
    stopCamera();
    capturedPhotos.forEach(p => URL.revokeObjectURL(p.url));
    onCancel();
  };

  useEffect(() => {
    startCamera();
    return () => {
      console.log('👋 [PhotoCapture] Unmounting');
      stopCamera();
    };
  }, [startCamera, stopCamera]);

  return ReactDOM.createPortal(
    <div className="fixed inset-0 z-[99999] bg-black flex items-center justify-center">
      <div className="bg-white rounded-xl shadow-2xl w-full h-full md:max-w-2xl md:max-h-[90vh] flex flex-col">
        <div className="border-b p-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-slate-900">Proof of Delivery Photos</h3>
          <Button variant="ghost" size="icon" onClick={handleCancel} disabled={isCapturing}>
            <X className="w-5 h-5" />
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-red-700 text-sm">
              {error}
            </div>
          )}

          {isCameraActive && (
            <div className="relative">
              <video 
                ref={videoRef} 
                autoPlay 
                playsInline 
                className="w-full rounded-lg bg-black"
              />
              <canvas ref={canvasRef} className="hidden" />
              
              <Button
                onClick={capturePhoto}
                disabled={capturedPhotos.length >= maxPhotos || isCapturing}
                className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-emerald-600 hover:bg-emerald-700 rounded-full w-16 h-16"
              >
                {isCapturing ? (
                  <Loader2 className="w-8 h-8 animate-spin" />
                ) : (
                  <Camera className="w-8 h-8" />
                )}
              </Button>
            </div>
          )}

          {capturedPhotos.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="text-sm font-medium text-slate-700">
                  Captured Photos ({capturedPhotos.length}/{maxPhotos})
                </p>
                {!isCameraActive && capturedPhotos.length < maxPhotos && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={startCamera}
                    disabled={isCapturing}
                  >
                    <Camera className="w-4 h-4 mr-2" />
                    Take Another
                  </Button>
                )}
              </div>
              
              <div className="grid grid-cols-2 gap-3">
                <AnimatePresence>
                  {capturedPhotos.map((photo, index) => (
                    <motion.div
                      key={index}
                      initial={{ opacity: 0, scale: 0.8 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.8 }}
                      className="relative group"
                    >
                      <img
                        src={photo.url}
                        alt={`Photo ${index + 1}`}
                        className="w-full h-32 object-cover rounded-lg border-2 border-slate-200"
                      />
                      <Button
                        variant="destructive"
                        size="icon"
                        className="absolute top-2 right-2 w-7 h-7 opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={() => removePhoto(index)}
                        disabled={isCapturing}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>
            </div>
          )}
        </div>

        <div className="border-t p-4 flex gap-3 justify-end">
          <Button variant="outline" onClick={handleCancel} disabled={isCapturing}>
            Cancel
          </Button>
          <Button 
            onClick={handleSave} 
            disabled={capturedPhotos.length === 0 || isCapturing}
            className="bg-emerald-600 hover:bg-emerald-700"
          >
            {isCapturing ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <Check className="w-4 h-4 mr-2" />
            )}
            Save {capturedPhotos.length} Photo{capturedPhotos.length !== 1 ? 's' : ''}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  );
}