import React, { useRef } from 'react';
import { Button } from '@/components/ui/button';
import { XCircle, RotateCcw, RotateCw, Crop } from 'lucide-react';

// ─── Document Viewer Modal ───────────────────────────────────────────────────
export function DocViewerModal({
  isMobile, viewingDoc, docUrl, docLoading,
  viewerRotation, setViewerRotation,
  savingRotation,
  onClose, onSaveRotation, onRecrop,
}) {
  if (!viewingDoc) return null;
  const isImage = !viewingDoc.mime_type?.includes('pdf');

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4"
      style={{ left: isMobile ? 0 : 'var(--sidebar-width, 260px)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-card rounded-xl shadow-2xl flex flex-col overflow-hidden"
        style={{ width: '100%', maxWidth: '900px', height: 'min(70vh, 70dvh)' }}>

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b flex-shrink-0 gap-2">
          <p className="font-semibold text-sm capitalize truncate">
            {viewingDoc.document_type?.replace(/_/g, ' ')}
            {viewingDoc.driver_name && ` — ${viewingDoc.driver_name}`}
            {viewingDoc.store_name && ` — ${viewingDoc.store_name}`}
          </p>
          <div className="flex items-center gap-1 flex-wrap justify-end flex-shrink-0">
            {docUrl && isImage && (
              <>
                <Button size="sm" variant="ghost" className="h-8 px-2" title="Rotate left"
                  disabled={savingRotation}
                  onClick={() => setViewerRotation((r) => (r - 90 + 360) % 360)}>
                  <RotateCcw className="w-4 h-4" />
                </Button>
                <Button size="sm" variant="ghost" className="h-8 px-2" title="Rotate right"
                  disabled={savingRotation}
                  onClick={() => setViewerRotation((r) => (r + 90) % 360)}>
                  <RotateCw className="w-4 h-4" />
                </Button>
                {viewerRotation !== 0 && (
                  <Button size="sm" className="h-8 px-2.5 bg-blue-600 hover:bg-blue-700 text-white gap-1.5"
                    disabled={savingRotation} onClick={onSaveRotation}>
                    {savingRotation
                      ? <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                      : '✓'} Save
                  </Button>
                )}
                <Button size="sm" variant="outline" className="h-8 px-2.5 gap-1.5"
                  disabled={savingRotation} onClick={onRecrop}>
                  <Crop className="w-3.5 h-3.5" /> Re-crop
                </Button>
              </>
            )}
            <Button size="sm" variant="ghost" onClick={onClose}>
              <XCircle className="w-4 h-4" /> Close
            </Button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-hidden relative">
          {docLoading ? (
            <div className="flex items-center justify-center h-full">
              <div className="w-8 h-8 border-2 border-slate-200 border-t-slate-800 rounded-full animate-spin" />
            </div>
          ) : docUrl ? (
            <div className="relative w-full h-full">
              {!isImage ? (
                <iframe src={`${docUrl}#toolbar=0&navpanes=0`} className="w-full h-full border-0" title="Document" />
              ) : (
                <img src={docUrl} alt="Document" className="w-full h-full object-contain"
                  style={{ pointerEvents: 'none', transform: `rotate(${viewerRotation}deg)`, transition: 'transform 0.2s' }} />
              )}
              {/* Watermark */}
              <div className="absolute inset-0 pointer-events-none overflow-hidden select-none" style={{ zIndex: 10 }}>
                {Array.from({ length: 20 }).map((_, i) => (
                  <div key={i} className="absolute font-bold text-2xl text-black/[0.07] whitespace-nowrap rotate-[-35deg]"
                    style={{ top: `${i % 5 * 22 - 5}%`, left: `${Math.floor(i / 5) * 28 - 10}%` }}>
                    CONFIDENTIAL
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-center text-sm text-muted-foreground py-8">Failed to load document</p>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Crop Modal ──────────────────────────────────────────────────────────────
export function DocCropModal({
  cropModal, cropImageRef,
  cropBox, setCropBox,
  cropRotation, setCropRotation,
  cropDrag, setCropDrag,
  uploadingForDriver,
  onClose, onConfirm, onSkip,
}) {
  if (!cropModal) return null;

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-card rounded-xl shadow-2xl w-full max-w-lg flex flex-col overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <p className="font-semibold text-sm">Adjust & Crop</p>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" className="h-8 px-2" title="Rotate left"
              onClick={() => { setCropRotation((r) => (r - 90 + 360) % 360); setCropBox({ x: 0.05, y: 0.05, w: 0.9, h: 0.9 }); }}>
              <RotateCcw className="w-4 h-4" />
            </Button>
            <Button variant="ghost" size="sm" className="h-8 px-2" title="Rotate right"
              onClick={() => { setCropRotation((r) => (r + 90) % 360); setCropBox({ x: 0.05, y: 0.05, w: 0.9, h: 0.9 }); }}>
              <RotateCw className="w-4 h-4" />
            </Button>
            <button className="text-muted-foreground hover:text-foreground ml-1" onClick={onClose}>✕</button>
          </div>
        </div>

        {/* Image + crop overlay */}
        <div className="relative select-none overflow-hidden bg-black"
          style={{ maxHeight: '55vh' }}
          onPointerMove={(e) => {
            if (!cropDrag) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const rx = (e.clientX - rect.left) / rect.width;
            const ry = (e.clientY - rect.top) / rect.height;
            if (cropDrag.type === 'move') {
              const nx = Math.max(0, Math.min(rx - cropDrag.ox, 1 - cropBox.w));
              const ny = Math.max(0, Math.min(ry - cropDrag.oy, 1 - cropBox.h));
              setCropBox((b) => ({ ...b, x: nx, y: ny }));
            } else if (cropDrag.type === 'resize') {
              const nw = Math.max(0.1, Math.min(rx - cropBox.x, 1 - cropBox.x));
              const nh = Math.max(0.1, Math.min(ry - cropBox.y, 1 - cropBox.y));
              setCropBox((b) => ({ ...b, w: nw, h: nh }));
            }
          }}
          onPointerUp={() => setCropDrag(null)}
          onPointerLeave={() => setCropDrag(null)}>

          <img ref={cropImageRef} src={cropModal.src} alt="crop preview"
            className="w-full object-contain"
            style={{ maxHeight: '55vh', display: 'block', transform: `rotate(${cropRotation}deg)`, transition: 'transform 0.2s' }}
            draggable={false} />

          {/* Dark overlay outside crop box */}
          <div className="absolute inset-0 pointer-events-none" style={{
            background: `linear-gradient(to bottom,
              rgba(0,0,0,0.5) ${cropBox.y * 100}%,
              transparent ${cropBox.y * 100}%,
              transparent ${(cropBox.y + cropBox.h) * 100}%,
              rgba(0,0,0,0.5) ${(cropBox.y + cropBox.h) * 100}%)`
          }}>
            <div className="absolute" style={{ left: 0, top: `${cropBox.y * 100}%`, width: `${cropBox.x * 100}%`, height: `${cropBox.h * 100}%`, background: 'rgba(0,0,0,0.5)' }} />
            <div className="absolute" style={{ right: 0, top: `${cropBox.y * 100}%`, width: `${(1 - cropBox.x - cropBox.w) * 100}%`, height: `${cropBox.h * 100}%`, background: 'rgba(0,0,0,0.5)' }} />
          </div>

          {/* Crop box */}
          <div className="absolute border-2 border-white"
            style={{ left: `${cropBox.x * 100}%`, top: `${cropBox.y * 100}%`, width: `${cropBox.w * 100}%`, height: `${cropBox.h * 100}%`, cursor: 'move', touchAction: 'none' }}
            onPointerDown={(e) => {
              e.stopPropagation();
              const rect = e.currentTarget.parentElement.getBoundingClientRect();
              const rx = (e.clientX - rect.left) / rect.width;
              const ry = (e.clientY - rect.top) / rect.height;
              setCropDrag({ type: 'move', ox: rx - cropBox.x, oy: ry - cropBox.y });
              e.currentTarget.setPointerCapture(e.pointerId);
            }}>
            {[['0%', '0%', '-4px', '-4px'], ['100%', '0%', '-4px', 'auto'], ['0%', '100%', 'auto', '-4px'], ['100%', '100%', 'auto', 'auto']].map(([l, t, mt, ml], i) => (
              <div key={i} className="absolute w-4 h-4 bg-white border border-gray-400 rounded-sm"
                style={{ left: l, top: t, marginTop: mt === 'auto' ? undefined : mt, marginLeft: ml === 'auto' ? undefined : ml, transform: 'translate(-50%, -50%)', cursor: 'se-resize', touchAction: 'none' }}
                onPointerDown={(e) => { e.stopPropagation(); setCropDrag({ type: 'resize' }); e.currentTarget.setPointerCapture(e.pointerId); }} />
            ))}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-t">
          <p className="text-xs text-muted-foreground">Drag box to move • drag corner to resize</p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onSkip}>Skip Crop</Button>
            <Button size="sm" onClick={onConfirm} disabled={!!uploadingForDriver}
              className="bg-blue-600 hover:bg-blue-700 text-white gap-1.5">
              {uploadingForDriver
                ? <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                : '✓'} Crop & Upload
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}