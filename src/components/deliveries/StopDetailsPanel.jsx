import React, { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { 
  User, 
  Phone, 
  MapPin, 
  Clock, 
  Package, 
  Building2, 
  StickyNote,
  CheckCircle,
  XCircle,
  AlertCircle,
  Pencil,
  Trash2,
  RotateCcw,
  Navigation,
  Thermometer,
  DollarSign,
  Bell,
  BellOff,
  Mail,
  Home,
  ArrowLeft,
  Image,
  FileSignature,
  Camera
} from "lucide-react";
import { format } from "date-fns";
import { formatPhoneNumber } from "../utils/phoneFormatter";
import SpecialSymbolsBadges from "../utils/SpecialSymbolsBadges";
import SignatureCapture from "../common/SignatureCapture";
import PhotoCapture from "../common/PhotoCapture";
import { base44 } from "@/api/base44Client";

const statusConfig = {
  pending: { color: 'bg-yellow-100 text-yellow-800 border-yellow-300', label: 'Pending', icon: Clock },
  'Ready For Pickup': { color: 'bg-blue-100 text-blue-800 border-blue-300', label: 'Ready For Pickup', icon: Package },
  picked_up: { color: 'bg-purple-100 text-purple-800 border-purple-300', label: 'Picked Up', icon: Package },
  in_transit: { color: 'bg-purple-100 text-purple-800 border-purple-300', label: 'In Transit', icon: Navigation },
  completed: { color: 'bg-emerald-100 text-emerald-800 border-emerald-300', label: 'Completed', icon: CheckCircle },
  failed: { color: 'bg-red-100 text-red-800 border-red-300', label: 'Failed', icon: XCircle },
  cancelled: { color: 'bg-slate-100 text-slate-800 border-slate-300', label: 'Cancelled', icon: XCircle },
  returned: { color: 'bg-orange-100 text-orange-800 border-orange-300', label: 'Returned', icon: RotateCcw },
  projected: { color: 'bg-gray-100 text-gray-700 border-gray-300', label: 'Projected', icon: Clock }
};

export default function StopDetailsPanel({ 
  delivery, 
  patient, 
  store, 
  driver,
  currentUser,
  onClose,
  onStatusUpdate,
  onEditDelivery,
  onDeleteDelivery,
  onRestart
}) {
  const [showSignatureCapture, setShowSignatureCapture] = useState(false);
  const [showPhotoCapture, setShowPhotoCapture] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);

  if (!delivery) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-6 text-center" style={{ background: 'var(--bg-slate-50)' }}>
        <Package className="w-16 h-16 mb-4 opacity-30" style={{ color: 'var(--text-slate-400)' }} />
        <p className="text-lg font-medium" style={{ color: 'var(--text-slate-500)' }}>Select a stop to view details</p>
        <p className="text-sm mt-1" style={{ color: 'var(--text-slate-400)' }}>Click on a stop card to see patient and delivery information</p>
      </div>
    );
  }

  const handleSignatureSave = async (blob) => {
    try {
      setIsUpdating(true);
      const file = new File([blob], 'signature.png', { type: 'image/png' });
      const uploadResponse = await base44.integrations.Core.UploadFile({ file });
      
      if (uploadResponse?.data?.file_url) {
        await base44.entities.Delivery.update(delivery.id, {
          signature_image_url: uploadResponse.data.file_url
        });
        setShowSignatureCapture(false);
      }
    } catch (error) {
      console.error('Failed to save signature:', error);
    } finally {
      setIsUpdating(false);
    }
  };

  const handlePhotosSave = async (photoBlobs) => {
    try {
      setIsUpdating(true);
      const uploadedUrls = [];
      
      for (const blob of photoBlobs) {
        const file = new File([blob], `proof-${Date.now()}.jpg`, { type: 'image/jpeg' });
        const uploadResponse = await base44.integrations.Core.UploadFile({ file });
        if (uploadResponse?.data?.file_url) {
          uploadedUrls.push(uploadResponse.data.file_url);
        }
      }
      
      if (uploadedUrls.length > 0) {
        const existingUrls = delivery.proof_photo_urls || [];
        await base44.entities.Delivery.update(delivery.id, {
          proof_photo_urls: [...existingUrls, ...uploadedUrls]
        });
        setShowPhotoCapture(false);
      }
    } catch (error) {
      console.error('Failed to save photos:', error);
    } finally {
      setIsUpdating(false);
    }
  };

  const clearSignature = async () => {
    try {
      setIsUpdating(true);
      await base44.entities.Delivery.update(delivery.id, {
        signature_image_url: null
      });
    } catch (error) {
      console.error('Failed to clear signature:', error);
    } finally {
      setIsUpdating(false);
    }
  };

  const hasSignature = !!delivery.signature_image_url;
  const hasPhotos = delivery.proof_photo_urls && delivery.proof_photo_urls.length > 0;
  const isCompleted = ['completed', 'failed', 'cancelled', 'returned'].includes(delivery.status);

  const isPickup = !delivery.patient_id;
  const status = statusConfig[delivery.status] || statusConfig.pending;
  const StatusIcon = status.icon;

  const canEdit = currentUser && (
    currentUser.app_roles?.includes('admin') || 
    currentUser.app_roles?.includes('dispatcher')
  );

  return (
    <div className="h-full flex flex-col overflow-hidden" style={{ background: 'var(--bg-slate-50)' }}>
      {/* Header */}
      <div className="flex-shrink-0 p-4 border-b" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" onClick={onClose} className="lg:hidden flex-shrink-0">
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <h2 className="text-lg font-bold flex-shrink-0" style={{ color: 'var(--text-slate-900)' }}>Stop Details</h2>
          <div className="flex-1" />
          <div className="flex items-center gap-2 flex-wrap justify-end">
            {store?.abbreviation && (
              <Badge 
                variant="outline" 
                className="rounded-full"
                style={{ borderColor: store.color || 'var(--border-slate-300)', color: store.color || 'var(--text-slate-600)', background: 'var(--bg-white)' }}
              >
                {store.abbreviation}
              </Badge>
            )}
            {delivery.stop_order && (
              <Badge variant="outline" className="rounded-full" style={{ background: 'var(--bg-white)', color: 'var(--text-slate-700)', borderColor: 'var(--border-slate-300)' }}>
                Stop# {String(delivery.stop_order).padStart(2, '0')}
              </Badge>
            )}
            {delivery.tracking_number && (
              <Badge variant="secondary" className="font-mono rounded-full" style={{ background: 'var(--bg-slate-100)', color: 'var(--text-slate-700)' }}>
                TR# {String(delivery.tracking_number).padStart(2, '0')}
              </Badge>
            )}
            {delivery.actual_delivery_time && (
              <Badge variant="secondary" className="font-mono rounded-full" style={{ background: 'var(--bg-slate-100)', color: 'var(--text-slate-700)' }}>
                <Clock className="w-3 h-3 mr-1" />
                {format(new Date(delivery.actual_delivery_time), 'h:mm a')}
              </Badge>
            )}
            <Badge className={`border rounded-full ${status.color}`} style={{ background: undefined, color: undefined }}>
              <StatusIcon className="w-3 h-3 mr-1" />
              {status.label}
            </Badge>
          </div>
        </div>
      </div>

      {/* Scrollable Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Patient Info Card */}
        <Card className="relative" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2" style={{ color: 'var(--text-slate-700)' }}>
              <User className="w-4 h-4" />
              {isPickup ? 'Store Pickup' : 'Patient Information'}
              {!isPickup && <SpecialSymbolsBadges delivery={delivery} patient={patient} isPickup={false} size="sm" />}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {isPickup ? (
              <>
                <div>
                  <p className="text-lg font-bold" style={{ color: 'var(--text-slate-900)' }}>
                    {store?.name || 'Store Pickup'}
                  </p>
                </div>
                {store?.address && (
                  <div className="flex items-start gap-2">
                    <MapPin className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: 'var(--text-slate-400)' }} />
                    <p className="text-sm" style={{ color: 'var(--text-slate-600)' }}>{store.address}</p>
                  </div>
                )}
                {store?.phone && (
                  <div className="flex items-center gap-2">
                    <Phone className="w-4 h-4" style={{ color: 'var(--text-slate-400)' }} />
                    <a href={`tel:${store.phone}`} className="text-sm text-blue-600 hover:underline">
                      {formatPhoneNumber(store.phone)}
                    </a>
                  </div>
                )}
              </>
            ) : patient ? (
              <>
                {/* Address with unit number */}
                {patient.address && (
                  <div className="flex items-start gap-2">
                    <MapPin className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: 'var(--text-slate-400)' }} />
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm" style={{ color: 'var(--text-slate-600)' }}>{patient.address}</p>
                        {patient.unit_number && (
                          <Badge variant="secondary" style={{ background: 'var(--bg-slate-100)', color: 'var(--text-slate-700)' }}>Unit {patient.unit_number}</Badge>
                        )}
                      </div>
                      {patient.distance_from_store && (
                        <p className="text-xs mt-0.5" style={{ color: 'var(--text-slate-400)' }}>
                          {patient.distance_from_store.toFixed(1)} km from store
                        </p>
                      )}
                    </div>
                  </div>
                )}

                {/* Patient Name */}
                <div>
                  <p className="text-lg font-bold" style={{ color: 'var(--text-slate-900)' }}>
                    {patient.full_name || delivery.patient_name || 'Unknown Patient'}
                  </p>
                </div>

                {patient.phone && (
                  <div className="flex items-center gap-2">
                    <Phone className="w-4 h-4" style={{ color: 'var(--text-slate-400)' }} />
                    <a href={`tel:${patient.phone}`} className="text-sm hover:underline" style={{ color: 'var(--text-slate-700)' }}>
                      {formatPhoneNumber(patient.phone)}
                    </a>
                  </div>
                )}

                {patient.phone_secondary && (
                  <div className="flex items-center gap-2">
                    <Phone className="w-4 h-4" style={{ color: 'var(--text-slate-400)' }} />
                    <a href={`tel:${patient.phone_secondary}`} className="text-sm hover:underline" style={{ color: 'var(--text-slate-700)' }}>
                      {formatPhoneNumber(patient.phone_secondary)} (Alt)
                    </a>
                  </div>
                )}

                {/* COD Information */}
                {(delivery.cod_total_amount_required > 0 || (delivery.cod_payments && delivery.cod_payments.length > 0)) && (
                  <div className="pt-2 border-t" style={{ borderColor: 'var(--border-slate-100)' }}>
                    <p className="text-xs font-medium mb-1 flex items-center gap-1" style={{ color: 'var(--text-slate-500)' }}>
                      <DollarSign className="w-3 h-3" /> COD Payment
                    </p>
                    {delivery.cod_total_amount_required > 0 && (
                      <p className="text-sm font-medium" style={{ color: 'var(--text-slate-700)' }}>
                        Required: ${delivery.cod_total_amount_required.toFixed(2)}
                      </p>
                    )}
                    {delivery.cod_payments && delivery.cod_payments.length > 0 && (
                      <div className="mt-1 space-y-1">
                        {delivery.cod_payments.map((payment, idx) => (
                          <p key={idx} className="text-sm" style={{ color: 'var(--text-slate-600)' }}>
                            {payment.type}: ${payment.amount.toFixed(2)}
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Patient Preferences */}
                <div className="flex flex-wrap gap-2 pt-2">
                  {patient.mailbox_ok && (
                    <Badge variant="outline" className="text-xs" style={{ background: 'var(--bg-white)', color: 'var(--text-slate-700)', borderColor: 'var(--border-slate-300)' }}>
                      <Mail className="w-3 h-3 mr-1" /> Mailbox OK
                    </Badge>
                  )}
                  {patient.call_upon_arrival && (
                    <Badge variant="outline" className="text-xs" style={{ background: 'var(--bg-white)', color: 'var(--text-slate-700)', borderColor: 'var(--border-slate-300)' }}>
                      <Phone className="w-3 h-3 mr-1" /> Call on Arrival
                    </Badge>
                  )}
                  {patient.ring_bell && !patient.dont_ring_bell && (
                    <Badge variant="outline" className="text-xs" style={{ background: 'var(--bg-white)', color: 'var(--text-slate-700)', borderColor: 'var(--border-slate-300)' }}>
                      <Bell className="w-3 h-3 mr-1" /> Ring Bell
                    </Badge>
                  )}
                  {patient.dont_ring_bell && (
                    <Badge variant="outline" className="text-xs text-orange-600 border-orange-300">
                      <BellOff className="w-3 h-3 mr-1" /> Don't Ring
                    </Badge>
                  )}
                  {patient.back_door && (
                    <Badge variant="outline" className="text-xs" style={{ background: 'var(--bg-white)', color: 'var(--text-slate-700)', borderColor: 'var(--border-slate-300)' }}>
                      <Home className="w-3 h-3 mr-1" /> Back Door
                    </Badge>
                  )}
                </div>

                {/* Patient Notes - only show if notes exist */}
                {patient.notes && (
                  <div className="pt-2 border-t" style={{ borderColor: 'var(--border-slate-100)' }}>
                    <p className="text-xs font-medium mb-1 flex items-center gap-1" style={{ color: 'var(--text-slate-500)' }}>
                      <StickyNote className="w-3 h-3" /> Patient Notes
                    </p>
                    <p className="text-sm" style={{ color: 'var(--text-slate-700)' }}>{patient.notes}</p>
                  </div>
                )}

                {/* Driver Notes - only show if notes exist */}
                {delivery.delivery_notes && (
                  <div className="pt-2 border-t" style={{ borderColor: 'var(--border-slate-100)' }}>
                    <p className="text-xs font-medium mb-1 flex items-center gap-1" style={{ color: 'var(--text-slate-500)' }}>
                      <StickyNote className="w-3 h-3" /> Driver Notes
                    </p>
                    <p className="text-sm" style={{ color: 'var(--text-slate-700)' }}>{delivery.delivery_notes}</p>
                  </div>
                )}
              </>
            ) : (
              <p className="text-sm" style={{ color: 'var(--text-slate-500)' }}>Patient information not available</p>
            )}
            
            {/* Admin Action Buttons - Bottom Right */}
            {currentUser?.app_roles?.includes('admin') && (
              <div className="absolute bottom-4 right-4 flex gap-2">
                <Button 
                  onClick={() => onEditDelivery(delivery)}
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                >
                  <Pencil className="w-4 h-4" style={{ color: 'var(--text-slate-500)' }} />
                </Button>
                <Button 
                  onClick={() => {
                    if (confirm('Are you sure you want to delete this delivery?')) {
                      onDeleteDelivery(delivery.id);
                    }
                  }}
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 hover:bg-red-50"
                >
                  <Trash2 className="w-4 h-4 text-red-600" />
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Images & Signatures Card */}
        <Card style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2" style={{ color: 'var(--text-slate-700)' }}>
              <Image className="w-4 h-4" />
              Proof of Delivery
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Signature */}
             <div className="flex items-center justify-between">
               <div className="flex-1">
                 {delivery.signature_image_url ? (
                   <div>
                     <p className="text-xs font-medium mb-2 flex items-center gap-1" style={{ color: 'var(--text-slate-500)' }}>
                       <FileSignature className="w-3 h-3" /> Signature
                     </p>
                     <div className="border rounded-lg overflow-hidden" style={{ borderColor: 'var(--border-slate-200)' }}>
                       <img 
                         src={delivery.signature_image_url} 
                         alt="Customer Signature" 
                         className="w-full h-auto max-h-32 object-contain bg-white"
                       />
                     </div>
                   </div>
                 ) : delivery.signature_needed ? (
                   <div className="text-center py-4 border rounded-lg" style={{ borderColor: 'var(--border-slate-200)', background: 'var(--bg-slate-50)' }}>
                     <FileSignature className="w-8 h-8 mx-auto mb-2 opacity-30" style={{ color: 'var(--text-slate-400)' }} />
                     <p className="text-sm" style={{ color: 'var(--text-slate-500)' }}>Signature required but not captured yet</p>
                   </div>
                 ) : null}
               </div>
               {!isCompleted && (
                 <div className="ml-3 flex flex-col gap-2">
                   <Button
                     onClick={() => setShowSignatureCapture(true)}
                     disabled={isUpdating}
                     className={`text-xs whitespace-nowrap ${
                       hasSignature 
                         ? 'bg-emerald-600 hover:bg-emerald-700 text-white' 
                         : 'bg-slate-200 hover:bg-slate-300 text-slate-700'
                     }`}
                     size="sm"
                   >
                     <FileSignature className="w-3 h-3 mr-1" />
                     {hasSignature ? 'Re-Capture' : 'Capture'}
                   </Button>
                   {hasSignature && (
                     <Button
                       onClick={clearSignature}
                       disabled={isUpdating}
                       variant="outline"
                       className="text-xs whitespace-nowrap"
                       size="sm"
                     >
                       <RotateCcw className="w-3 h-3 mr-1" />
                       Clear
                     </Button>
                   )}
                 </div>
               )}
             </div>

            {/* Proof Photos */}
             <div className="flex items-start justify-between">
               <div className="flex-1">
                 {delivery.proof_photo_urls && delivery.proof_photo_urls.length > 0 ? (
                   <div>
                     <p className="text-xs font-medium mb-2 flex items-center gap-1" style={{ color: 'var(--text-slate-500)' }}>
                       <Image className="w-3 h-3" /> Proof Photos ({delivery.proof_photo_urls.length})
                     </p>
                     <div className="grid grid-cols-2 gap-2">
                       {delivery.proof_photo_urls.map((url, index) => (
                         <div key={index} className="border rounded-lg overflow-hidden" style={{ borderColor: 'var(--border-slate-200)' }}>
                           <img 
                             src={url} 
                             alt={`Proof photo ${index + 1}`} 
                             className="w-full h-24 object-cover cursor-pointer hover:opacity-90 transition-opacity"
                             onClick={() => window.open(url, '_blank')}
                           />
                         </div>
                       ))}
                     </div>
                   </div>
                 ) : null}
               </div>
               {!isCompleted && (
                 <Button
                   onClick={() => setShowPhotoCapture(true)}
                   disabled={isUpdating}
                   className={`text-xs whitespace-nowrap ml-3 ${
                     hasPhotos 
                       ? 'bg-emerald-600 hover:bg-emerald-700 text-white' 
                       : 'bg-slate-200 hover:bg-slate-300 text-slate-700'
                   }`}
                   size="sm"
                 >
                   <Camera className="w-3 h-3 mr-1" />
                   {hasPhotos ? 'Add Photo' : 'Capture'}
                 </Button>
               )}
             </div>

            {/* Empty state if no images or signatures */}
            {!delivery.signature_image_url && !delivery.signature_needed && (!delivery.proof_photo_urls || delivery.proof_photo_urls.length === 0) && (
              <div className="text-center py-6" style={{ color: 'var(--text-slate-400)' }}>
                <Image className="w-10 h-10 mx-auto mb-2 opacity-30" />
                <p className="text-sm">No proof of delivery images</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Action Buttons - Only Complete/Failed for non-admins */}
      {canEdit && !currentUser?.app_roles?.includes('admin') && (
        <div className="flex-shrink-0 p-4 border-t" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
          {!isCompleted && (
            <div className="flex gap-2">
              <Button 
                onClick={() => onStatusUpdate(delivery.id, 'completed')}
                className="flex-1 bg-emerald-600 hover:bg-emerald-700"
              >
                <CheckCircle className="w-4 h-4 mr-2" />
                Complete
              </Button>
              <Button 
                onClick={() => onStatusUpdate(delivery.id, 'failed')}
                variant="destructive"
                className="flex-1"
              >
                <XCircle className="w-4 h-4 mr-2" />
                Failed
              </Button>
            </div>
          )}
        </div>
      )}

      {showSignatureCapture && (
        <SignatureCapture
          onSave={handleSignatureSave}
          onCancel={() => setShowSignatureCapture(false)}
          customerName={patient?.full_name || delivery.patient_name}
          isSaved={hasSignature}
        />
      )}

      {showPhotoCapture && (
        <PhotoCapture
          onSave={handlePhotosSave}
          onCancel={() => setShowPhotoCapture(false)}
          maxPhotos={3}
        />
      )}
      </div>
      );
      }