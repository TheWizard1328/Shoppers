import React, { useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Camera, Scan, CheckCircle2, Loader2 } from "lucide-react";

export default function DeliveryCameraOverlay({
  show,
  videoRef,
  canvasRef,
  isScanning,
  error,
  onCapture,
  onClose,
}) {
  const scanLineRef = useRef(null);

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

          {/* Auto-capture scanning indicator */}
          {!isScanning && !error && (
            <div className="absolute top-4 left-1/2 -translate-x-1/2 flex items-center gap-2 px-3 py-1.5 bg-black/70 rounded-full">
              <Scan className="w-4 h-4 text-emerald-400 animate-pulse" />
              <span className="text-sm text-white/90">Scanning... hold steady</span>
            </div>
          )}

          {/* Scanning overlay frame */}
          {!isScanning && !error && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div className="relative w-[80%] aspect-[4/3]">
                {/* Corner brackets */}
                <div className="absolute -top-1 -left-1 w-8 h-8 border-t-4 border-l-4 border-emerald-400 rounded-tl" />
                <div className="absolute -top-1 -right-1 w-8 h-8 border-t-4 border-r-4 border-emerald-400 rounded-tr" />
                <div className="absolute -bottom-1 -left-1 w-8 h-8 border-b-4 border-l-4 border-emerald-400 rounded-bl" />
                <div className="absolute -bottom-1 -right-1 w-8 h-8 border-b-4 border-r-4 border-emerald-400 rounded-br" />
                {/* Animated scan line */}
                <motion.div
                  ref={scanLineRef}
                  className="absolute left-0 right-0 h-[2px] bg-emerald-400/70"
                  initial={{ top: "0%" }}
                  animate={{ top: ["0%", "100%", "0%"] }}
                  transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
                />
              </div>
            </div>
          )}

          {isScanning && (
            <div className="absolute top-4 left-1/2 -translate-x-1/2 flex items-center gap-2 px-3 py-1.5 bg-emerald-600/90 rounded-full">
              <Loader2 className="w-4 h-4 text-white animate-spin" />
              <span className="text-sm text-white">Analyzing label...</span>
            </div>
          )}

          <div className="absolute bottom-4 left-0 right-0 flex justify-center gap-4">
            <Button variant="outline" onClick={onClose} disabled={isScanning}>Cancel</Button>
            <Button onClick={onCapture} disabled={isScanning}>
              {isScanning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Camera className="w-4 h-4" />}
              {isScanning ? 'Scanning...' : 'Capture Now'}
            </Button>
          </div>

          {error && <div className="absolute top-4 p-2 bg-red-500 text-white rounded text-sm">{error}</div>}

          {/* Auto-capture hint */}
          <div className="absolute bottom-16 left-0 right-0 text-center">
            <span className="text-xs text-white/50">Auto-captures when label is sharp</span>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
