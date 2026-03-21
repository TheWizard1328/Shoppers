import React, { useEffect, useRef } from 'react';
import { Label } from '@/components/ui/label';
import JsBarcode from 'jsbarcode';

export default function LargeBarcodePreview({ value, onClose }) {
  const svgRef = useRef(null);

  useEffect(() => {
    if (!svgRef.current || !value) return;
    try {
      JsBarcode(svgRef.current, String(value), {
        format: 'CODE128',
        lineColor: '#000000',
        background: '#ffffff',
        width: 3,
        height: 180,
        displayValue: false,
        margin: 24,
      });
    } catch {}
  }, [value]);

  if (!value) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label className="text-sm font-semibold text-slate-900 dark:text-slate-100">Selected Barcode</Label>
      </div>
      <div className="rounded-md border bg-white dark:bg-slate-800 dark:border-slate-700 p-3">
        <svg ref={svgRef} className="w-full h-44" aria-label="Selected barcode" />
      </div>
    </div>
  );
}