import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Camera } from "lucide-react";

export default function DeliveryCameraOverlay({
  show,
  videoRef,
  canvasRef,
  isScanning,
  error,
  onCapture,
  onClose,
}) {
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
          <video ref={videoRef} autoPlay playsInline className="w-full h-full object-contain rounded-lg" />
          <canvas ref={canvasRef} style={{ display: 'none' }} />
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