import { useState, useRef, useEffect, useCallback } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { PenLine, RotateCcw, Loader2, FileText, ShieldCheck } from 'lucide-react';
import { base44 } from '@/api/base44Client';

/**
 * Electronic-signature dialog for Compliance & Legal documents (IMA / NDA).
 *
 * Flow: store owner opens the template, draws their signature on the canvas,
 * confirms the legal attestation, and the signature PNG is uploaded and stored
 * on a `signed` ComplianceDocument record (signature_image_uri), bound to the
 * template version it was signed against (signed_from_version) — so version
 * bumps trigger the existing "Re-sign needed" logic.
 *
 * The signature itself is the legal artifact; the template PDF stays untouched
 * (the app has no server-side PDF-stamping capability — pdf-lib is not bundled).
 * Audit trail = authenticated user id (signed_by_user_id), name, and UTC
 * timestamp (signed_at), all persisted on the record.
 */
export default function ComplianceSignDialog({ open, onClose, doc, docMeta, currentUser, onSigned }) {
  const canvasRef = useRef(null);
  const isDrawingRef = useRef(false);
  const [hasSignature, setHasSignature] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState(null);
  const [agreed, setAgreed] = useState(false);

  // Fixed logical canvas size — exported PNG keeps this aspect regardless of
  // the on-screen CSS size (canvas backing store set once, drawn in device px).
  const CANVAS_W = 900;
  const CANVAS_H = 300;

  const setupCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = CANVAS_W;
    canvas.height = CANVAS_H;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 3.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }, []);

  useEffect(() => {
    if (open) {
      setHasSignature(false);
      setError(null);
      setAgreed(false);
      // Reset canvas after the dialog mounts
      const t = setTimeout(setupCanvas, 50);
      return () => clearTimeout(t);
    }
  }, [open, setupCanvas]);

  if (!doc || !docMeta) return null;

  const getCoords = (e) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = CANVAS_W / rect.width;
    const scaleY = CANVAS_H / rect.height;
    const source = e.touches && e.touches.length > 0 ? e.touches[0] : e;
    return {
      x: (source.clientX - rect.left) * scaleX,
      y: (source.clientY - rect.top) * scaleY,
    };
  };

  const startDrawing = (e) => {
    if (isSaving) return;
    isDrawingRef.current = true;
    setHasSignature(true);
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    const { x, y } = getCoords(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
    // Draw a dot so single taps register
    ctx.lineTo(x + 0.01, y + 0.01);
    ctx.stroke();
  };

  const draw = (e) => {
    if (!isDrawingRef.current) return;
    e.preventDefault();
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    const { x, y } = getCoords(e);
    ctx.lineTo(x, y);
    ctx.stroke();
  };

  const stopDrawing = () => {
    isDrawingRef.current = false;
  };

  const clearSignature = () => {
    if (isSaving) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    setHasSignature(false);
  };

  const handleSave = async () => {
    if (!hasSignature || !agreed || isSaving) return;
    setIsSaving(true);
    setError(null);
    try {
      // 1. Export the canvas to a PNG blob
      const blob = await new Promise((resolve, reject) => {
        canvasRef.current.toBlob((result) => {
          if (!result || !result.size) reject(new Error('Signature is empty'));
          else resolve(result);
        }, 'image/png');
      });

      const file = new File([blob], `signature-${doc.document_type}-${Date.now()}.png`, { type: 'image/png' });
      const { file_url: signatureUrl } = await base44.integrations.Core.UploadFile({ file });

      // 2. Persist the signed ComplianceDocument bound to this template version
      const signerName = currentUser?.user_name || currentUser?.full_name || 'Unknown';
      const nowIso = new Date().toISOString();
      await base44.entities.ComplianceDocument.create({
        document_type: doc.document_type,
        title: docMeta.label + ' — Signed (' + signerName + ')',
        status: 'signed',
        file_url: doc.file_url, // reference to the template that was signed
        mime_type: 'application/pdf',
        version: doc.version,
        store_owner_id: currentUser?.id,
        store_owner_name: signerName,
        covered_store_ids: currentUser?.store_ids || [],
        signed_by_name: signerName,
        signed_by_user_id: currentUser?.id,
        signed_at: nowIso,
        signature_image_uri: signatureUrl,
        signed_from_version: doc.version,
        uploaded_at: nowIso,
        uploaded_by: currentUser?.id,
        uploaded_by_name: signerName,
      });

      if (onSigned) await onSigned();
      onClose();
    } catch (err) {
      console.error('[ComplianceSignDialog] Save failed:', err);
      setError(err?.message || 'Failed to save signature. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !isSaving) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <PenLine className="w-4 h-4 text-blue-600" />
            Sign Electronically — {docMeta.label}
          </DialogTitle>
          <DialogDescription className="flex items-center gap-2 flex-wrap">
            <FileText className="w-3.5 h-3.5" />
            {doc.title || docMeta.label}
            {doc.version && <Badge variant="outline" className="text-xs px-1.5 py-0 h-5">{doc.version}</Badge>}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {/* Template preview link */}
          {doc.file_url && (
            <div className="text-xs flex items-center gap-1.5 p-2 rounded-md bg-muted/50 border border-border">
              <ShieldCheck className="w-3.5 h-3.5 flex-shrink-0 text-emerald-600" />
              <span>
                Review the full document before signing:{' '}
                <a href={doc.file_url} target="_blank" rel="noreferrer" className="underline text-blue-600 dark:text-blue-400">
                  Open PDF
                </a>
              </span>
            </div>
          )}

          {/* Signature canvas */}
          <div className="rounded-lg border-2 border-border overflow-hidden bg-white relative">
            <canvas
              ref={canvasRef}
              onMouseDown={startDrawing}
              onMouseMove={draw}
              onMouseUp={stopDrawing}
              onMouseLeave={stopDrawing}
              onTouchStart={startDrawing}
              onTouchMove={draw}
              onTouchEnd={stopDrawing}
              onTouchCancel={stopDrawing}
              className="w-full block cursor-crosshair"
              style={{ touchAction: 'none', aspectRatio: '3 / 1' }}
            />
            {!hasSignature && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <span className="text-lg select-none text-slate-300">✍️ Draw your signature here</span>
              </div>
            )}
          </div>

          <div className="flex justify-end">
            <Button variant="outline" size="sm" className="text-xs h-7 px-2" onClick={clearSignature} disabled={!hasSignature || isSaving}>
              <RotateCcw className="w-3 h-3 mr-1" /> Clear
            </Button>
          </div>

          {/* Legal attestation */}
          <label className="flex items-start gap-2 text-xs text-muted-foreground cursor-pointer select-none p-2 rounded-md border border-border bg-muted/30">
            <input
              type="checkbox"
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
              disabled={isSaving}
              className="mt-0.5"
            />
            <span>
              I confirm I am <strong>{currentUser?.user_name || currentUser?.full_name || 'the store owner'}</strong>, I have
              reviewed the document above, and I consent to applying this electronic signature as my legally binding
              signature on behalf of my store(s). My name, account, and the signing timestamp are recorded for audit purposes.
            </span>
          </label>

          {error && (
            <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={isSaving}>Cancel</Button>
          <Button
            size="sm"
            className="bg-emerald-600 hover:bg-emerald-700"
            onClick={handleSave}
            disabled={!hasSignature || !agreed || isSaving}
          >
            {isSaving
              ? <><Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> Saving…</>
              : <><PenLine className="w-3.5 h-3.5 mr-1" /> Apply Signature</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
