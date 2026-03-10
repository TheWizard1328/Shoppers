import React, { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
  Camera,
  X
} from "lucide-react";
import { format } from "date-fns";
import { formatPhoneNumber } from "../utils/phoneFormatter";
import SpecialSymbolsBadges from "../utils/SpecialSymbolsBadges";
import SignatureCapture from "../common/SignatureCapture";
import PhotoCapture from "../common/PhotoCapture";
import ImageViewer from "../common/ImageViewer";
import BarcodeThumb from "./BarcodeThumb";
import BarcodeOverlay from "./BarcodeOverlay";
import { base44 } from "@/api/base44Client";

const statusConfig = {
  pending: { color: 'bg-yellow-100 text-yellow-800 border-yellow-300 dark:bg-yellow-900/30 dark:text-yellow-300 dark:border-yellow-700', label: 'Pending', icon: Clock },
  'Ready For Pickup': { color: 'bg-blue-100 text-blue-800 border-blue-300 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-700', label: 'Ready For Pickup', icon: Package },
  picked_up: { color: 'bg-purple-100 text-purple-800 border-purple-300 dark:bg-purple-900/30 dark:text-purple-300 dark:border-purple-700', label: 'Picked Up', icon: Package },
  in_transit: { color: 'bg-purple-100 text-purple-800 border-purple-300 dark:bg-purple-900/30 dark:text-purple-300 dark:border-purple-700', label: 'In Transit', icon: Navigation },
  completed: { color: 'bg-emerald-100 text-emerald-800 border-emerald-300 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-700', label: 'Completed', icon: CheckCircle },
  failed: { color: 'bg-red-100 text-red-800 border-red-300 dark:bg-red-900/30 dark:text-red-300 dark:border-red-700', label: 'Failed', icon: XCircle },
  cancelled: { color: 'bg-slate-100 text-slate-800 border-slate-300 dark:bg-slate-800/60 dark:text-slate-200 dark:border-slate-600', label: 'Cancelled', icon: XCircle },
  returned: { color: 'bg-orange-100 text-orange-800 border-orange-300 dark:bg-orange-900/30 dark:text-orange-300 dark:border-orange-700', label: 'Returned', icon: RotateCcw },
  projected: { color: 'bg-gray-100 text-gray-700 border-gray-300 dark:bg-gray-800/60 dark:text-gray-200 dark:border-gray-600', label: 'Projected', icon: Clock }
};

export default function StopDetailsPanel({ 
  delivery, 
  patient, 
  store, 
  driver,
  currentUser,
  onClose,
  onStatusUpdate,
  onEdit = () => console.warn('[StopDetailsPanel] onEdit not provided'),
  onDelete = null,
  onRestart
}) {
  const [showSignatureCapture, setShowSignatureCapture] = useState(false);
  const [showPhotoCapture, setShowPhotoCapture] = useState(false);
  const [viewingImage, setViewingImage] = useState(null);
  const [isUpdating, setIsUpdating] = useState(false);
  const [barcodePreview, setBarcodePreview] = useState(null);
  const completionTimeRef = useRef(null);
  const [editableStatus, setEditableStatus] = useState(delivery?.status || 'pending');
  const [deliveryTimeStart, setDeliveryTimeStart] = useState(delivery?.delivery_time_start || '');
  const [deliveryTimeEnd, setDeliveryTimeEnd] = useState(delivery?.delivery_time_end || '');
  const [completionTime, setCompletionTime] = useState(
    delivery?.actual_delivery_time ? format(new Date(delivery.actual_delivery_time), 'HH:mm') : format(new Date(), 'HH:mm')
  );

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

  const deletePhoto = async (indexToDelete) => {
    try {
      setIsUpdating(true);
      const updatedUrls = delivery.proof_photo_urls.filter((_, i) => i !== indexToDelete);
      await base44.entities.Delivery.update(delivery.id, {
        proof_photo_urls: updatedUrls
      });
    } catch (error) {
      console.error('Failed to delete photo:', error);
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
    currentUser.app_roles?.includes('driver') || 
    currentUser.app_roles?.includes('dispatcher')
  );

  useEffect(() => {
    setEditableStatus(delivery?.status || 'pending');
    setDeliveryTimeStart(delivery?.delivery_time_start || '');
    setDeliveryTimeEnd(delivery?.delivery_time_end || '');
    setCompletionTime(
      delivery?.actual_delivery_time ? format(new Date(delivery.actual_delivery_time), 'HH:mm') : format(new Date(), 'HH:mm')
    );
  }, [delivery?.id, delivery?.status, delivery?.delivery_time_start, delivery?.delivery_time_end, delivery?.actual_delivery_time]);

  const activeStatuses = ['in_transit', 'en_route'];
  const completionStatuses = ['completed', 'failed', 'cancelled'];
  const isActiveEditStatus = activeStatuses.includes(editableStatus);
  const isCompletionEditStatus = completionStatuses.includes(editableStatus);
  const showDesktopClearButtons = typeof window !== 'undefined' && !window.matchMedia('(pointer: coarse)').matches;

  const handleStatusChange = (value) => {
    const wasCompletionStatus = completionStatuses.includes(editableStatus);
    const changingToCompletion = completionStatuses.includes(value) && !wasCompletionStatus;
    setEditableStatus(value);
    if (changingToCompletion) {
      setCompletionTime(format(new Date(), 'HH:mm'));
      setTimeout(() => completionTimeRef.current?.focus(), 50);
    }
  };

  const handleApplyStatusTiming = async () => {
    if (!canEdit) return;

    setIsUpdating(true);
    try {
      const timingUpdate = {};

      if (isActiveEditStatus) {
        timingUpdate.delivery_time_start = deliveryTimeStart || '';
        timingUpdate.delivery_time_end = deliveryTimeEnd || '';
      }

      if (isCompletionEditStatus && completionTime && delivery?.delivery_date) {
        timingUpdate.actual_delivery_time = `${delivery.delivery_date}T${completionTime}:00`;
      }

      const statusChanged = editableStatus !== delivery.status;

      if (statusChanged && typeof onStatusUpdate === 'function') {
        await onStatusUpdate(delivery.id, editableStatus, {}, true);
      }

      if (!statusChanged || Object.keys(timingUpdate).length > 0) {
        await base44.entities.Delivery.update(delivery.id, statusChanged ? timingUpdate : { status: editableStatus, ...timingUpdate });
        window.dispatchEvent(new CustomEvent('deliveryUpdated', {
          detail: {
            deliveryId: delivery.id,
            updates: statusChanged ? timingUpdate : { status: editableStatus, ...timingUpdate },
            driverId: delivery.driver_id,
            deliveryDate: delivery.delivery_date,
            source: 'stopDetailsPanel'
          }
        }));
        window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
          detail: {
            driverId: delivery.driver_id,
            deliveryDate: delivery.delivery_date,
            triggeredBy: 'stopDetailsPanel'
          }
        }));
      }
    } finally {
      setIsUpdating(false);
    }
  };

  return (
    <div className="h-full flex flex-col overflow-hidden" style={{ background: 'var(--bg-slate-50)' }}>
      <style>{`
        .stop-details-time-input-desktop::-webkit-calendar-picker-indicator {
          opacity: 0;
          pointer-events: none;
        }
      `}</style>
      {/* Header */}
      <div className="flex-shrink-0 p-4 border-b" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" onClick={onClose} className="flex-shrink-0">
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
      <div className="flex-1 overflow-y-auto px-4 pt-4 pb-2 space-y-4">
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
                    <a href={`tel:${store.phone}`} className="text-sm hover:underline" style={{ color: 'var(--text-slate-700)' }}>
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
                    <Badge variant="outline" className="text-xs" style={{ background: 'var(--bg-white)', color: '#ea580c', borderColor: '#fdba74' }}>
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

            {/* Status & Timing */}
            {canEdit && typeof onStatusUpdate === 'function' && (
              <div className="pt-2 border-t" style={{ borderColor: 'var(--border-slate-100)' }}>
                <p className="text-xs font-medium mb-2" style={{ color: 'var(--text-slate-500)' }}>
                  Status & Timing
                </p>
                <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_auto] gap-2 items-end">

                  <div className="min-w-0 w-full space-y-1">
                    <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>
                      {isPickup ? 'Pickup Status' : 'Delivery Status'}
                    </Label>
                    <Select value={editableStatus} onValueChange={handleStatusChange} disabled={isUpdating}>
                      <SelectTrigger className="h-9">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="z-[10030]">
                        {isPickup ? (
                          <>
                            <SelectItem value="en_route">En Route</SelectItem>
                            <SelectItem value="completed">Completed</SelectItem>
                            <SelectItem value="cancelled">Cancelled</SelectItem>
                          </>
                        ) : (
                          <>
                            <SelectItem value="pending">Pending</SelectItem>
                            <SelectItem value="in_transit">In Transit</SelectItem>
                            <SelectItem value="completed">Completed</SelectItem>
                            <SelectItem value="failed">Failed</SelectItem>
                            <SelectItem value="cancelled">Cancelled</SelectItem>
                          </>
                        )}
                      </SelectContent>
                    </Select>
                  </div>

                  {isActiveEditStatus && (
                    <>
                      <div className="min-w-0 w-full space-y-1">
                        <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>
                          Start
                        </Label>
                        <div className="relative">
                          <Input type="time" value={deliveryTimeStart} onChange={(e) => setDeliveryTimeStart(e.target.value)} disabled={isUpdating} className={`h-9 text-sm ${showDesktopClearButtons ? 'pr-8 stop-details-time-input-desktop' : ''}`} />
                          {showDesktopClearButtons && deliveryTimeStart && (
                            <button type="button" onClick={() => setDeliveryTimeStart('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600" disabled={isUpdating}>
                              <X className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      </div>
                      <div className="min-w-0 w-full space-y-1">
                        <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>
                          End
                        </Label>
                        <div className="relative">
                          <Input type="time" value={deliveryTimeEnd} onChange={(e) => setDeliveryTimeEnd(e.target.value)} disabled={isUpdating} className={`h-9 text-sm ${showDesktopClearButtons ? 'pr-8 stop-details-time-input-desktop' : ''}`} />
                          {showDesktopClearButtons && deliveryTimeEnd && (
                            <button type="button" onClick={() => setDeliveryTimeEnd('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600" disabled={isUpdating}>
                              <X className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      </div>
                    </>
                  )}

                  {isCompletionEditStatus && (
                    <>
                      <div className="min-w-0 w-full space-y-1">
                        <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>
                          Completion
                        </Label>
                        <div className="relative">
                        <Input ref={completionTimeRef} type="time" value={completionTime} onChange={(e) => setCompletionTime(e.target.value)} disabled={isUpdating} className={`h-9 text-sm ${showDesktopClearButtons ? 'pr-8 stop-details-time-input-desktop' : ''}`} />
                        {showDesktopClearButtons && completionTime && (
                          <button type="button" onClick={() => setCompletionTime('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600" disabled={isUpdating}>
                            <X className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                      </div>
                      <div className="min-w-0 w-full space-y-1 opacity-0 pointer-events-none" aria-hidden="true">
                        <Label className="text-sm font-semibold">End</Label>
                        <Input type="time" value="" readOnly className="h-9 text-sm" />
                      </div>
                    </>
                  )}

                  {!(isActiveEditStatus || isCompletionEditStatus) && (
                    <>
                      <div className="min-w-0 w-full space-y-1 opacity-0 pointer-events-none" aria-hidden="true">
                        <Label className="text-sm font-semibold">Start</Label>
                        <Input type="time" value="" readOnly className="h-9 text-sm" />
                      </div>
                      <div className="min-w-0 w-full space-y-1 opacity-0 pointer-events-none" aria-hidden="true">
                        <Label className="text-sm font-semibold">End</Label>
                        <Input type="time" value="" readOnly className="h-9 text-sm" />
                      </div>
                    </>
                  )}

                  <Button onClick={handleApplyStatusTiming} disabled={isUpdating} size="sm" className="bg-emerald-600 hover:bg-emerald-700 text-white h-9 px-3 whitespace-nowrap">
                    Apply
                  </Button>
                </div>
              </div>
            )}
            
            {/* Admin Action Buttons - Bottom Right */}
            {currentUser?.app_roles?.includes('admin') && (
              <div className="absolute top-4 right-4 flex gap-2">
                <Button 
                  onClick={() => onEdit(delivery)}
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                >
                  <Pencil className="w-4 h-4" style={{ color: 'var(--text-slate-500)' }} />
                </Button>
                <Button 
                  onClick={() => {
                    if (confirm('Are you sure you want to delete this delivery?')) {
                      if (typeof onDelete === 'function') {
                        onDelete(delivery.id);
                      } else {
                        console.warn('[StopDetailsPanel] onDelete not provided');
                      }
                    }
                  }}
                  disabled={typeof onDelete !== 'function'}
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  style={{ color: '#dc2626' }}
                >
                  <Trash2 className="w-4 h-4 text-red-600" />
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Barcode Thumbnails */}
        {(delivery?.receipt_barcode_values?.length > 0 || delivery?.barcode_values?.length > 0) && (
          <Card style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold" style={{ color: 'var(--text-slate-700)' }}>
                Barcodes
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {delivery?.receipt_barcode_values?.length > 0 && (
                <div>
                  <p className="text-xs font-medium mb-2" style={{ color: 'var(--text-slate-500)' }}>
                    Receipt Barcodes ({delivery.receipt_barcode_values.length})
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    {delivery.receipt_barcode_values.map((val, idx) => (
                      <div
                        key={`rb-${idx}`}
                        className="border rounded-md p-2 cursor-pointer transition-colors"
                        style={{ borderColor: 'var(--border-slate-200)', background: 'var(--bg-white)' }}
                        onClick={() => setBarcodePreview(val)}
                      >
                        <BarcodeThumb value={val} />
                        <p className="mt-1 text-[11px] text-center text-slate-500 break-all">{val}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {delivery?.barcode_values?.length > 0 && (
                <div>
                  <p className="text-xs font-medium mb-2" style={{ color: 'var(--text-slate-500)' }}>
                    Rx Barcodes ({delivery.barcode_values.length})
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    {delivery.barcode_values.map((val, idx) => (
                      <div
                        key={`rx-${idx}`}
                        className="border rounded-md p-2 cursor-pointer transition-colors"
                        style={{ borderColor: 'var(--border-slate-200)', background: 'var(--bg-white)' }}
                        onClick={() => setBarcodePreview(val)}
                      >
                        <BarcodeThumb value={val} />
                        <p className="mt-1 text-[11px] text-center text-slate-500 break-all">{val}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        )}

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
                     <div
                       className="border rounded-lg overflow-hidden cursor-pointer hover:opacity-80 transition-opacity"
                       style={{ borderColor: 'var(--border-slate-200)' }}
                       onClick={() => setViewingImage({ url: delivery.signature_image_url, title: 'Customer Signature' })}
                     >
                       <img 
                         src={delivery.signature_image_url} 
                         alt="Customer Signature" 
                         className="w-full h-auto max-h-32 object-contain"
                         style={{ background: 'var(--bg-white)' }}
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
                     className={`text-xs whitespace-nowrap ${hasSignature ? 'bg-emerald-600 hover:bg-emerald-700 text-white' : ''}`}
                     style={!hasSignature ? { background: 'var(--bg-slate-100)', color: 'var(--text-slate-700)', border: '1px solid var(--border-slate-300)' } : {}}
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
                       style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-700)' }}
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
                         <div key={index} className="relative border rounded-lg overflow-hidden group" style={{ borderColor: 'var(--border-slate-200)' }}>
                           <img 
                             src={url} 
                             alt={`Proof photo ${index + 1}`} 
                             className="w-full h-24 object-cover cursor-pointer hover:opacity-90 transition-opacity"
                             onClick={() => setViewingImage({ url, title: `Proof Photo ${index + 1}` })}
                           />
                           <button
                             onClick={(e) => { e.stopPropagation(); deletePhoto(index); }}
                             disabled={isUpdating}
                             className="absolute top-1 right-1 rounded-full w-5 h-5 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity disabled:opacity-50"
                            style={{ background: '#dc2626', color: '#ffffff' }}
                           >
                             <X className="w-3 h-3" />
                           </button>
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
                   className={`text-xs whitespace-nowrap ml-3 ${hasPhotos ? 'bg-emerald-600 hover:bg-emerald-700 text-white' : ''}`}
                   style={!hasPhotos ? { background: 'var(--bg-slate-100)', color: 'var(--text-slate-700)', border: '1px solid var(--border-slate-300)' } : {}}
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

      {/* Action Buttons - Drivers */}
      {currentUser?.app_roles?.includes('driver') && (
        <div className="flex-shrink-0 p-4 border-t" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
          {!isCompleted ? (
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
          ) : (
            ['completed', 'failed', 'cancelled'].includes(delivery.status) && onRestart && (
              <div className="flex gap-2">
                <Button
                  onClick={() => onRestart(delivery.id)}
                  className="flex-1 bg-blue-600 hover:bg-blue-700 text-white"
                  disabled={isUpdating}
                >
                  <RotateCcw className="w-4 h-4 mr-2" />
                  Restart
                </Button>
              </div>
            )
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

      {viewingImage && (
        <ImageViewer
          imageUrl={viewingImage.url}
          title={viewingImage.title}
          onClose={() => setViewingImage(null)}
        />
      )}

      {barcodePreview && (
        <BarcodeOverlay value={barcodePreview} onClose={() => setBarcodePreview(null)} />
      )}
      </div>
      );
      }