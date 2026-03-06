import React, { useEffect, useRef } from 'react';
import JsBarcode from 'jsbarcode';

export default function BarcodeOverlay({ value, onClose }) {
  const svgRef = useRef(null);

  useEffect(() => {
    if (!svgRef.current || !value) return;
    try {
      JsBarcode(svgRef.current, String(value), {
        format: 'CODE128',
        lineColor: '#000000',
        background: '#ffffff',
        width: 3,
        height: 200,
        displayValue: false,
        margin: 24,
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
      <div className="max-w-[95vw] w-full sm:max-w-2xl">
        <div className="rounded-xl border p-4 bg-white">
          <div className="flex flex-col items-center gap-3 select-none">
            <svg ref={svgRef} className="w-full h-[200px]" aria-hidden="true" />
            <p className="text-xs text-slate-700 break-all">{value}</p>
            <p className="text-[11px] text-slate-500">Tap anywhere to close</p>
          </div>
        </div>
      </div>
    </div>
  );
}