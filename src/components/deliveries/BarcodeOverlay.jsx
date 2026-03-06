import React, { useEffect, useRef } from 'react';
import JsBarcode from 'jsbarcode';

export default function BarcodeOverlay({ value, onClose }) {
  const svgRef = useRef(null);

  useEffect(() => {
    if (!svgRef.current || !value) return;
    try {
      JsBarcode(svgRef.current, String(value), {
        format: 'CODE128',
        lineColor: '#ffffff',
        background: 'transparent',
        width: 2,
        height: 180,
        displayValue: false,
        margin: 10,
      });
    } catch {}
  }, [value]);

  if (!value) return null;

  return (
    <div
      className="fixed inset-0 z-[20000] bg-black/60 flex items-center justify-center p-6"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Barcode preview"
    >
      <div className="max-w-[95vw] w-full sm:max-w-2xl bg-transparent">
        <div className="rounded-xl border border-white/30 p-4 backdrop-blur-sm bg-black/30">
          <div className="flex flex-col items-center gap-3 select-none">
            <svg ref={svgRef} className="w-full h-[180px]" aria-hidden="true" />
            <p className="text-xs text-white/70 break-all">{value}</p>
            <p className="text-[11px] text-white/60">Tap anywhere to close</p>
          </div>
        </div>
      </div>
    </div>
  );
}