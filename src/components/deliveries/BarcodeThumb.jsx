import React, { useEffect, useRef } from 'react';
import JsBarcode from 'jsbarcode';

export default function BarcodeThumb({ value, height = 40, className = "w-full h-10" }) {
  const svgRef = useRef(null);

  useEffect(() => {
    if (!svgRef.current || !value) return;
    try {
      const barcodeValue = String(value).slice(0, 8);
      JsBarcode(svgRef.current, barcodeValue, {
        format: 'CODE128',
        lineColor: '#111827',
        width: 1.5,
        height: height,
        displayValue: false,
        margin: 0,
      });
    } catch {}
  }, [value, height]);

  return <svg ref={svgRef} className={className} aria-hidden="true" />;
}