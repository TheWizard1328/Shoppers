import React, { useEffect, useRef } from 'react';
import JsBarcode from 'jsbarcode';

export default function BarcodeThumb({ value }) {
  const svgRef = useRef(null);

  useEffect(() => {
    if (!svgRef.current || !value) return;
    try {
      JsBarcode(svgRef.current, String(value), {
        format: 'CODE128',
        lineColor: '#111827',
        width: 1.5,
        height: 40,
        displayValue: false,
        margin: 0,
      });
    } catch {}
  }, [value]);

  return <svg ref={svgRef} className="w-full h-10" aria-hidden="true" />;
}