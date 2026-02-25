import React from "react";
import ReactDOM from "react-dom";
import { Button } from "@/components/ui/button";
import { X, Pen, Camera, Eye } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { toast } from "sonner";
import { invalidate } from '../utils/dataManager';
import SignatureCapture from './SignatureCapture';
import PhotoCapture from './PhotoCapture';

export default function StopCardPOD({
  delivery,
  displayName,
  isNextDelivery,
  isFinishedDelivery,
  isPickup,
  viewingImageUrl,
  setViewingImageUrl,
  showSignatureCapture,
  setShowSignatureCapture,
  showPhotoCapture,
  setShowPhotoCapture,
  forceRefreshDriverDeliveries,
  showButtons = true,
}) {
  const handleSignatureSave = async (signatureBlob) => {
    try {
      const signatureFile = new File([signatureBlob], 'signature.png', { type: 'image/png' });
      const uploadResult = await base44.integrations.Core.UploadFile({ file: signatureFile });
      await base44.entities.Delivery.update(delivery.id, { signature_image_url: uploadResult.file_url });
      setShowSignatureCapture(false);
      invalidate('Delivery');
      await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date);
      toast.success('Signature saved!');
    } catch (error) {
      console.error('❌ [Signature] Save failed:', error);
      toast.error(`Failed to save signature: ${error.message}`);
      setShowSignatureCapture(false);
    }
  };

  const handlePhotoSave = async (photoBlobs) => {
    try {
      const uploadPromises = photoBlobs.map((blob, i) => {
        const file = new File([blob], `photo_${i + 1}.jpg`, { type: 'image/jpeg' });
        return base44.integrations.Core.UploadFile({ file });
      });
      const results = await Promise.all(uploadPromises);
      const newPhotoUrls = results.map((r) => r.file_url);
      const existingPhotos = delivery.proof_photo_urls || [];
      await base44.entities.Delivery.update(delivery.id, { proof_photo_urls: [...existingPhotos, ...newPhotoUrls] });
      setShowPhotoCapture(false);
      invalidate('Delivery');
      await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date);
      toast.success(`${photoBlobs.length} photo(s) saved!`);
    } catch (error) {
      console.error('❌ [Photos] Save failed:', error);
      toast.error(`Failed to save photos: ${error.message}`);
      setShowPhotoCapture(false);
    }
  };

  return (
    <>
      {/* Fullscreen Image Viewer */}
      {viewingImageUrl && ReactDOM.createPortal(
        <div
          className="fixed inset-0 flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.75)', zIndex: 999999, pointerEvents: 'auto' }}
          onClick={() => setViewingImageUrl(null)}>
          <div
            className="relative bg-white rounded-xl shadow-2xl p-4 max-w-[95vw] max-h-[90vh] flex flex-col items-center"
            onClick={(e) => e.stopPropagation()}>
            <button
              onClick={() => setViewingImageUrl(null)}
              className="absolute -top-3 -right-3 bg-white border-2 border-slate-300 hover:bg-red-50 hover:border-red-400 text-slate-700 hover:text-red-600 rounded-full w-9 h-9 flex items-center justify-center shadow-lg transition-colors z-10">
              <X className="w-5 h-5" />
            </button>
            <img src={viewingImageUrl} alt="Proof of delivery" className="max-w-full max-h-[75vh] object-contain rounded-lg" style={{ background: 'white' }} />
            <p className="mt-3 text-sm text-slate-500 font-medium">Tap outside to close</p>
          </div>
        </div>,
        document.body
      )}

      {/* Signature Capture */}
      {showSignatureCapture &&
        <SignatureCapture
          customerName={displayName}
          onSave={handleSignatureSave}
          onCancel={() => setShowSignatureCapture(false)} />
      }

      {/* Photo Capture */}
      {showPhotoCapture &&
        <PhotoCapture
          onSave={handlePhotoSave}
          onCancel={() => setShowPhotoCapture(false)}
          maxPhotos={3} />
      }

      {/* POD Buttons - Only for non-pickup, non-finished or completed with proof (shown when showButtons=true) */}
      {showButtons && !isPickup && (
        <div className="flex items-center gap-2">
          {/* Signature Button */}
          {((isNextDelivery && !isFinishedDelivery) || (delivery.status === 'completed' && delivery.signature_image_url)) && (
            <div className="flex items-center">
              <Button
                onClick={(e) => {
                  e.stopPropagation();
                  if (delivery.status === 'completed' && delivery.signature_image_url) {
                    setViewingImageUrl(delivery.signature_image_url);
                  } else {
                    setShowSignatureCapture(true);
                  }
                }}
                size="sm"
                variant="outline"
                className={`h-10 md:h-8 w-10 md:w-8 p-0 ${delivery.signature_image_url ? 'bg-emerald-100 border-emerald-400 hover:bg-emerald-200' : 'bg-slate-100 border-slate-400 hover:bg-slate-200'}`}
              >
                {delivery.status === 'completed' && delivery.signature_image_url ? (
                  <Eye className="w-5 h-5 md:w-4 md:h-4 text-emerald-700" />
                ) : (
                  <Pen className={`w-5 h-5 md:w-4 md:h-4 ${delivery.signature_image_url ? 'text-emerald-700' : 'text-slate-600'}`} />
                )}
              </Button>
              {delivery.signature_image_url && delivery.status !== 'completed' && (
                <Button
                  onClick={async (e) => {
                    e.stopPropagation();
                    await base44.entities.Delivery.update(delivery.id, { signature_image_url: null });
                    invalidate('Delivery');
                    await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date);
                  }}
                  size="sm"
                  variant="outline"
                  className="h-10 md:h-8 w-6 p-0 bg-red-50 border-red-300 hover:bg-red-100 border-l-0 rounded-l-none"
                >
                  <X className="w-3 h-3 text-red-500" />
                </Button>
              )}
            </div>
          )}

          {/* Photo Button */}
          {((isNextDelivery && !isFinishedDelivery) || (delivery.status === 'completed' && delivery.proof_photo_urls && delivery.proof_photo_urls.length > 0)) && (
            <div className="flex items-center">
              <Button
                onClick={(e) => {
                  e.stopPropagation();
                  if (delivery.status === 'completed' && delivery.proof_photo_urls?.length > 0) {
                    setViewingImageUrl(delivery.proof_photo_urls[0]);
                  } else {
                    setShowPhotoCapture(true);
                  }
                }}
                size="sm"
                variant="outline"
                className={`h-10 md:h-8 w-10 md:w-8 p-0 ${delivery.proof_photo_urls && delivery.proof_photo_urls.length > 0 ? 'bg-emerald-100 border-emerald-400 hover:bg-emerald-200' : 'bg-slate-100 border-slate-400 hover:bg-slate-200'}`}
              >
                {delivery.status === 'completed' && delivery.proof_photo_urls?.length > 0 ? (
                  <Eye className="w-5 h-5 md:w-4 md:h-4 text-emerald-700" />
                ) : (
                  <Camera className={`w-5 h-5 md:w-4 md:h-4 ${delivery.proof_photo_urls && delivery.proof_photo_urls.length > 0 ? 'text-emerald-700' : 'text-slate-600'}`} />
                )}
              </Button>
              {delivery.proof_photo_urls && delivery.proof_photo_urls.length > 0 && delivery.status !== 'completed' && (
                <Button
                  onClick={async (e) => {
                    e.stopPropagation();
                    await base44.entities.Delivery.update(delivery.id, { proof_photo_urls: [] });
                    invalidate('Delivery');
                    await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date);
                  }}
                  size="sm"
                  variant="outline"
                  className="h-10 md:h-8 w-6 p-0 bg-red-50 border-red-300 hover:bg-red-100 border-l-0 rounded-l-none"
                >
                  <X className="w-3 h-3 text-red-500" />
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}