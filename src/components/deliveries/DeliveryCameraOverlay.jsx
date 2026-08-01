import React, { useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Camera, SwitchCamera } from "lucide-react";
import { listCameras, cycleRearCamera } from "./useDeliveryCamera";

export default function DeliveryCameraOverlay({
  show,
  videoRef,
  canvasRef,
  isScanning,
  error,
  onCapture,
  onClose,
}) {
  const [cameraCount, setCameraCount] = useState(1);
  const [switching, setSwitching] = useState(false);

  const handleSwitch = useCallback(async () => {
    if (switching || isScanning || !videoRef.current) return;
    setSwitching(true);
    try {
      const result = await cycleRearCamera(videoRef.current);
      if (result?.stream && videoRef.current) {
        videoRef.current.srcObject = result.stream;
        try { await videoRef.current.play(); } catch {}
      }
      try {
        const cams = await listCameras();
        setCameraCount(cams.length);
      } catch {}
    } catch (e) {
      console.warn('[DeliveryCameraOverlay] Switch failed:', e?.message);
    } finally {
      setSwitching(false);
    }
  }, [switching, isScanning, videoRef]);

  React.useEffect(() => {
    if (show) {
      listCameras().then(cams => setCameraCount(cams.length)).catch(() => {});
    }
  }, [show]);

  if (!show) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[10030] bg-black flex items-center justify-center p-2"
      >
        <div className="relative w-full max-w-lg h-full max-h-[90vh] bg-black flex flex-col items-center justify-center rounded-lg shadow-xl">
          <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-contain rounded-lg" />
          <canvas ref={canvasRef} style={{ display: 'none' }} />

          {/* Switch Camera button — bottom right of viewfinder, one-hand reachable */}
          {cameraCount > 1 && (
            <button
              type="button"
              onClick={handleSwitch}
              disabled={isScanning || switching}
              className="absolute bottom-20 right-3 z-10 flex items-center justify-center rounded-full bg-white/25 backdrop-blur-sm w-12 h-12 text-white transition active:bg-white/40 disabled:opacity-50 touch-manipulation"
              title="Switch camera lens"
              style={{ WebkitTapHighlightColor: 'transparent' }}
            >
              {switching
                ? <div className="animate-spin w-5 h-5 border-2 border-white border-t-transparent rounded-full" />
                : <SwitchCamera className="w-6 h-6" />}
            </button>
          )}

          <div className="absolute bottom-4 left-0 right-0 flex justify-center gap-4">
            <Button variant="outline" onClick={onClose} disabled={isScanning}>Cancel</Button>
            <Button onClick={onCapture} disabled={isScanning}>
              {isScanning ? <div className="animate-spin w-4 h-4 border-2 border-white border-t-transparent rounded-full" /> : <Camera className="w-4 h-4" />}
              Capture & Scan
            </Button>
          </div>
          {error && <div className="absolute top-4 p-2 bg-red-500 text-white rounded">{error}</div>}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
