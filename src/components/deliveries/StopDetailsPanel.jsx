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
  X } from
"lucide-react";
import { format } from "date-fns";
import { formatPhoneNumber } from "../utils/phoneFormatter";
import { isAppOwner } from "../utils/userRoles";
import SpecialSymbolsBadges from "../utils/SpecialSymbolsBadges";
import SignatureCapture from "../common/SignatureCapture";
import PhotoCapture from "../common/PhotoCapture";
import ImageViewer from "../common/ImageViewer";
import BarcodeThumb from "./BarcodeThumb";
import BarcodeOverlay from "./BarcodeOverlay";
import { base44 } from "@/api/base44Client";
import { persistDeliveryProof } from "../utils/persistDeliveryProof";
import { toast } from "sonner";
import { calculateRealTimeETA } from "@/functions/calculateRealTimeETA";
import { recalculateAndUpdateStopOrders } from "../utils/stopOrderManager";
import { isRouteCompleted } from "../utils/routeCompletionChecker";
import { useDeliveryDisplayInfo } from "../common/StopCardRedaction";
import { userHasRole } from "../utils/userRoles";

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
  onRestart,
  allDeliveries = []
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
  const [codAmountRequired, setCodAmountRequired] = useState(delivery?.cod_total_amount_required || 0);
  const [completionTime, setCompletionTime] = useState(
    delivery?.actual_delivery_time ? format(new Date(delivery.actual_delivery_time), 'HH:mm') : format(new Date(), 'HH:mm')
  );

  useEffect(() => {
    if (!delivery) return;
    setEditableStatus(delivery?.status || 'pending');
    setDeliveryTimeStart(delivery?.delivery_time_start || '');
    setDeliveryTimeEnd(delivery?.delivery_time_end || '');
    setCodAmountRequired(delivery?.cod_total_amount_required || 0);
    setCompletionTime(
      delivery?.actual_delivery_time ? format(new Date(delivery.actual_delivery_time), 'HH:mm') : format(new Date(), 'HH:mm')
    );
  }, [delivery?.id, delivery?.status, delivery?.delivery_time_start, delivery?.delivery_time_end, delivery?.actual_delivery_time]);

  // Must be called before any early returns to satisfy React hooks rules
  const isPickupForHook = !delivery?.patient_id;
  const { finalDisplayName, finalDisplayAddress, finalDisplayPhone, shouldRedact } = useDeliveryDisplayInfo({
    delivery: delivery || {},
    patient,
    store,
    currentUser,
    isPickup: isPickupForHook,
    isInterStore: false,
    isInterStorePickup: false,
    isStrippedDelivery: false,
    isStrippedForDispatcher: false,
  });

  if (!delivery) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-6 text-center" style={{ background: 'var(--bg-slate-50)' }}>
        <Package className="w-16 h-16 mb-4 opacity-30" style={{ color: 'var(--text-slate-400)' }} />
        <p className="text-lg font-medium" style={{ color: 'var(--text-slate-500)' }}>Select a stop to view details</p>
        <p className="text-sm mt-1" style={{ color: 'var(--text-slate-400)' }}>Click on a stop card to see patient and delivery information</p>
      </div>);

  }

  const handleSignatureSave = async (blob) => {
    try {
      setIsUpdating(true);
      const file = new File([blob], 'signature.png', { type: 'image/png' });
      const uploadResponse = await base44.integrations.Core.UploadFile({ file });
      const fileUrl = uploadResponse?.file_url || uploadResponse?.data?.file_url;

      if (fileUrl) {
        await persistDeliveryProof(delivery.id, {
          signature_image_url: fileUrl
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
        const fileUrl = uploadResponse?.file_url || uploadResponse?.data?.file_url;
        if (fileUrl) {
          uploadedUrls.push(fileUrl);
        }
      }

      if (uploadedUrls.length > 0) {
        const existingUrls = delivery.proof_photo_urls || [];
        await persistDeliveryProof(delivery.id, {
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
      await persistDeliveryProof(delivery.id, {
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
      await persistDeliveryProof(delivery.id, {
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

  const isDispatcherUser = currentUser?.app_roles?.includes('dispatcher');
  const isDriverUser = currentUser?.app_roles?.includes('driver');
  const isAdminUser = currentUser?.app_roles?.includes('admin') || currentUser?.role === 'admin';
  const canEdit = currentUser && (isDriverUser || isAdminUser || isDispatcherUser);
  const canViewProofOfDelivery = true;
  const canEditProofOfDelivery = !isDispatcherUser;
  const canEditTimeWindows = isDispatcherUser && delivery?.status === 'pending';
  const canEditCodInCurrentState = !!currentUser && !!patient && (
  isDispatcherUser && delivery?.status === 'pending' ||
  (isDriverUser || isAdminUser) && ['pending', 'in_transit'].includes(delivery?.status));

  const canManageStop = currentUser && (
  isAdminUser || currentUser.app_roles?.includes('driver') && !isRouteCompleted(delivery, allDeliveries));

  const activeStatuses = ['in_transit', 'en_route'];
  const completionStatuses = ['completed', 'failed', 'cancelled'];
  const isActiveEditStatus = activeStatuses.includes(editableStatus);
  const isCompletionEditStatus = completionStatuses.includes(editableStatus);
  const showTimeWindowEditors = canEditTimeWindows || isActiveEditStatus;
  const showDesktopClearButtons = typeof window !== 'undefined' && !window.matchMedia('(pointer: coarse)').matches;
  const initialCompletionTime = delivery?.actual_delivery_time ? format(new Date(delivery.actual_delivery_time), 'HH:mm') : '';
  const hasStatusTimingChanges = (() => {
    if (editableStatus !== (delivery?.status || 'pending')) return true;
    if (showTimeWindowEditors) {
      return (deliveryTimeStart || '') !== (delivery?.delivery_time_start || '') || (deliveryTimeEnd || '') !== (delivery?.delivery_time_end || '');
    }
    if (isCompletionEditStatus) {
      return (completionTime || '') !== initialCompletionTime;
    }
    return false;
  })();

  const canDeleteCodInCurrentState = canEditCodInCurrentState && (!delivery?.cod_payments || delivery.cod_payments.length === 0);
  const hasCodChanges = Number(codAmountRequired || 0) !== Number(delivery?.cod_total_amount_required || 0);

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

      if (showTimeWindowEditors) {
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
      }

      try {
        await recalculateAndUpdateStopOrders(delivery.driver_id, delivery.delivery_date);
      } catch (error) {
        console.warn('⚠️ [StopDetailsPanel] Stop order refresh skipped:', error?.message || error);
      }

      const now = new Date();
      const currentLocalTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      const edmToday = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Edmonton',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).format(now);
      if (delivery.delivery_date === edmToday) {
        try {
          await calculateRealTimeETA({
            driverId: delivery.driver_id,
            deliveryDate: delivery.delivery_date,
            currentLocalTime
          });
        } catch (error) {
          console.warn('⚠️ [StopDetailsPanel] ETA refresh skipped:', error?.response?.status || error?.message || error);
        }
      }

      window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
        detail: {
          driverId: delivery.driver_id,
          deliveryDate: delivery.delivery_date,
          triggeredBy: 'stopDetailsPanel'
        }
      }));
      window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));

      onClose?.();
    } finally {
      setIsUpdating(false);
    }
  };

  const handleTimeFieldKeyDown = (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (!isUpdating && hasStatusTimingChanges) {
        handleApplyStatusTiming();
      }
    }
  };

  const handleSaveCodAmount = async () => {
    if (!canEditCodInCurrentState) return;
    setIsUpdating(true);
    try {
      const nextAmount = Math.max(0, Number(codAmountRequired || 0));
      await base44.entities.Delivery.update(delivery.id, {
        cod_total_amount_required: nextAmount
      });
      window.dispatchEvent(new CustomEvent('deliveryUpdated', {
        detail: {
          deliveryId: delivery.id,
          updates: { cod_total_amount_required: nextAmount },
          driverId: delivery.driver_id,
          deliveryDate: delivery.delivery_date,
          source: 'stopDetailsPanelCod'
        }
      }));
      window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
        detail: {
          driverId: delivery.driver_id,
          deliveryDate: delivery.delivery_date,
          triggeredBy: 'stopDetailsPanelCod'
        }
      }));
      toast.success('COD amount updated');
    } finally {
      setIsUpdating(false);
    }
  };

  const handleDeleteCodAmount = async () => {
    if (!canDeleteCodInCurrentState) return;
    setIsUpdating(true);
    try {
      await base44.entities.Delivery.update(delivery.id, {
        cod_total_amount_required: 0,
        cod_payments: []
      });
      setCodAmountRequired(0);
      window.dispatchEvent(new CustomEvent('deliveryUpdated', {
        detail: {
          deliveryId: delivery.id,
          updates: { cod_total_amount_required: 0, cod_payments: [] },
          driverId: delivery.driver_id,
          deliveryDate: delivery.delivery_date,
          source: 'stopDetailsPanelCodDelete'
        }
      }));
      window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
        detail: {
          driverId: delivery.driver_id,
          deliveryDate: delivery.delivery_date,
          triggeredBy: 'stopDetailsPanelCodDelete'
        }
      }));
      toast.success('COD removed');
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
      <div className="flex-shrink-0 border-b px-4 py-2" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>

        {/* ── DESKTOP layout (md+): unchanged single row ── */}
        <div className="hidden md:flex items-center gap-2">
          <Button variant="ghost" size="icon" onClick={onClose} className="flex-shrink-0">
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <h2 className="text-lg font-bold flex-shrink-0" style={{ color: 'var(--text-slate-900)' }}>Stop Details</h2>
          <div className="flex-1" />
          <div className="flex items-center gap-2 flex-wrap justify-end">
            {store?.abbreviation &&
            <Badge variant="outline" className="rounded-full" style={{ borderColor: store.color || 'var(--border-slate-300)', color: store.color || 'var(--text-slate-600)', background: 'var(--bg-white)' }}>
              {store.abbreviation}
            </Badge>
            }
            {delivery.stop_order &&
            <Badge variant="outline" className="rounded-full" style={{ background: 'var(--bg-white)', color: 'var(--text-slate-700)', borderColor: 'var(--border-slate-300)' }}>
              Stop# {String(delivery.stop_order).padStart(2, '0')}
            </Badge>
            }
            {delivery.tracking_number &&
            <Badge variant="secondary" className="font-mono rounded-full" style={{ background: 'var(--bg-slate-100)', color: 'var(--text-slate-700)' }}>
              TR# {String(delivery.tracking_number).padStart(2, '0')}
            </Badge>
            }
            {delivery.ampm_deliveries &&
            <Badge variant="outline" className="rounded-full" style={{ background: 'var(--bg-white)', color: 'var(--text-slate-700)', borderColor: 'var(--border-slate-300)' }}>
              {delivery.ampm_deliveries}
            </Badge>
            }
            {delivery.actual_delivery_time &&
            <Badge variant="secondary" className="font-mono rounded-full" style={{ background: 'var(--bg-slate-100)', color: 'var(--text-slate-700)' }}>
              <Clock className="w-3 h-3 mr-1" />
              {format(new Date(delivery.actual_delivery_time), 'h:mm a')}
            </Badge>
            }
            {isAppOwner(currentUser) && delivery.puid &&
            <Badge variant="outline" className="font-mono rounded-full" style={{ background: 'var(--bg-white)', color: 'var(--text-slate-700)', borderColor: 'var(--border-slate-300)' }}>
              PUID {delivery.puid}
            </Badge>
            }
            {isAppOwner(currentUser) && delivery.stop_id &&
            <Badge variant="outline" className="font-mono rounded-full" style={{ background: 'var(--bg-white)', color: 'var(--text-slate-700)', borderColor: 'var(--border-slate-300)' }}>
              SID {delivery.stop_id}
            </Badge>
            }
            {isAppOwner(currentUser) && patient?.patient_id &&
            <Badge variant="outline" className="font-mono rounded-full" style={{ background: 'var(--bg-white)', color: 'var(--text-slate-700)', borderColor: 'var(--border-slate-300)' }}>
              PID {patient.patient_id}
            </Badge>
            }
            <Badge className={`border rounded-full ${status.color}`}>
              <StatusIcon className="w-3 h-3 mr-1" />
              {status.label}
            </Badge>
          </div>
        </div>

        {/* ── MOBILE layout (<md): two-row structured header ── */}
        <div className="flex flex-col gap-1 md:hidden">
          {/* Row 1: back arrow + title | store badge + status badge */}
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" onClick={onClose} className="flex-shrink-0 -ml-2">
              <ArrowLeft className="w-5 h-5" />
            </Button>
            <h2 className="text-lg font-bold flex-1" style={{ color: 'var(--text-slate-900)' }}>Stop Details</h2>
            <div className="flex items-center gap-1.5 flex-shrink-0">
              {store?.abbreviation &&
              <Badge variant="outline" className="rounded-full" style={{ borderColor: store.color || 'var(--border-slate-300)', color: store.color || 'var(--text-slate-600)', background: 'var(--bg-white)' }}>
                {store.abbreviation}
              </Badge>
              }
              <Badge className={`border rounded-full ${status.color}`}>
                <StatusIcon className="w-3 h-3 mr-1" />
                {status.label}
              </Badge>
            </div>
          </div>

          {/* Row 2: Stop#, TR#, AM/PM, delivery time */}
          <div className="flex items-center gap-1.5 flex-wrap pl-1">
            {delivery.stop_order &&
            <Badge variant="outline" className="rounded-full text-xs" style={{ background: 'var(--bg-white)', color: 'var(--text-slate-700)', borderColor: 'var(--border-slate-300)' }}>
              Stop# {String(delivery.stop_order).padStart(2, '0')}
            </Badge>
            }
            {delivery.tracking_number &&
            <Badge variant="secondary" className="font-mono rounded-full text-xs" style={{ background: 'var(--bg-slate-100)', color: 'var(--text-slate-700)' }}>
              TR# {String(delivery.tracking_number).padStart(2, '0')}
            </Badge>
            }
            {delivery.ampm_deliveries &&
            <Badge variant="outline" className="rounded-full text-xs" style={{ background: 'var(--bg-white)', color: 'var(--text-slate-700)', borderColor: 'var(--border-slate-300)' }}>
              {delivery.ampm_deliveries}
            </Badge>
            }
            {delivery.actual_delivery_time &&
            <Badge variant="secondary" className="font-mono rounded-full text-xs" style={{ background: 'var(--bg-slate-100)', color: 'var(--text-slate-700)' }}>
              <Clock className="w-3 h-3 mr-1" />
              {format(new Date(delivery.actual_delivery_time), 'h:mm a')}
            </Badge>
            }
          </div>

          {/* Row 3: owner-only badges (PUID, SID, PID) */}
          {isAppOwner(currentUser) && (delivery.puid || delivery.stop_id || patient?.patient_id) &&
          <div className="flex items-center gap-1.5 flex-wrap pl-1">
            {delivery.puid &&
            <Badge variant="outline" className="font-mono rounded-full text-xs" style={{ background: 'var(--bg-white)', color: 'var(--text-slate-700)', borderColor: 'var(--border-slate-300)' }}>
              PUID {delivery.puid}
            </Badge>
            }
            {delivery.stop_id &&
            <Badge variant="outline" className="font-mono rounded-full text-xs" style={{ background: 'var(--bg-white)', color: 'var(--text-slate-700)', borderColor: 'var(--border-slate-300)' }}>
              SID {delivery.stop_id}
            </Badge>
            }
            {patient?.patient_id &&
            <Badge variant="outline" className="font-mono rounded-full text-xs" style={{ background: 'var(--bg-white)', color: 'var(--text-slate-700)', borderColor: 'var(--border-slate-300)' }}>
              PID {patient.patient_id}
            </Badge>
            }
          </div>
          }
        </div>

      </div>

      {/* Scrollable Content */}
      <div className="flex-1 overflow-y-auto space-y-4 py-2 px-2">
        {/* Patient Info Card */}
        <Card style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between gap-2">
              {/* Patient Name */}
                <p className="text-lg font-bold" style={{ color: 'var(--text-slate-900)' }}>
                  {finalDisplayName}
                </p>
              {/* Edit/Delete Buttons inline with name */}
              {canManageStop &&
              <div className="flex items-center gap-1 flex-shrink-0">
                <Button onClick={() => onEdit(delivery)} variant="ghost" size="icon" className="h-8 w-8">
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
                  className="h-8 w-8">
                  <Trash2 className="w-4 h-4 text-red-600" />
                </Button>
              </div>
              }
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {isPickup ?
            <>
                <div>
                  <p className="text-lg font-bold" style={{ color: 'var(--text-slate-900)' }}>
                    {store?.name || 'Store Pickup'}
                  </p>
                </div>
                {store?.address &&
              <div className="flex items-start gap-2">
                    <MapPin className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: 'var(--text-slate-400)' }} />
                    <p className="text-sm" style={{ color: 'var(--text-slate-600)' }}>{store.address}</p>
                  </div>
              }
                {store?.phone &&
              <div className="flex items-center gap-2">
                    <Phone className="w-4 h-4" style={{ color: 'var(--text-slate-400)' }} />
                    <a href={`tel:${store.phone}`} className="text-sm hover:underline" style={{ color: 'var(--text-slate-700)' }}>
                      {formatPhoneNumber(store.phone)}
                    </a>
                  </div>
              }
              </> :
            patient ?
            <div className="flex gap-4">
              {/* LEFT column: address, phone, COD, preferences */}
              <div className="w-[60%] min-w-0 space-y-3">
                {/* Address with unit number */}
                {!isPickup && finalDisplayAddress &&
                <div className="flex items-start gap-2">
                  <MapPin className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: 'var(--text-slate-400)' }} />
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm" style={{ color: 'var(--text-slate-600)' }}>{finalDisplayAddress}</p>
                      {patient.unit_number &&
                      <Badge variant="secondary" style={{ background: 'var(--bg-slate-100)', color: 'var(--text-slate-700)' }}>Unit {patient.unit_number}</Badge>
                      }
                    </div>
                    {patient.distance_from_store &&
                    <p className="text-xs mt-0.5" style={{ color: 'var(--text-slate-400)' }}>
                      {patient.distance_from_store.toFixed(1)} km from store
                    </p>
                    }
                  </div>
                </div>
                }

                {finalDisplayPhone &&
                <div className="flex items-center gap-2">
                  <Phone className="w-4 h-4" style={{ color: 'var(--text-slate-400)' }} />
                  {shouldRedact ? (
                    <span className="text-sm" style={{ color: 'var(--text-slate-700)' }}>
                      {finalDisplayPhone}
                    </span>
                  ) : (
                    <a href={`tel:${patient.phone}`} className="text-sm hover:underline" style={{ color: 'var(--text-slate-700)' }}>
                      {finalDisplayPhone}
                    </a>
                  )}
                </div>
                }

                {patient.phone_secondary &&
                <div className="flex items-center gap-2">
                  <Phone className="w-4 h-4" style={{ color: 'var(--text-slate-400)' }} />
                  <a href={`tel:${patient.phone_secondary}`} className="text-sm hover:underline" style={{ color: 'var(--text-slate-700)' }}>
                    {formatPhoneNumber(patient.phone_secondary)} (Alt)
                  </a>
                </div>
                }

                {/* COD Information */}
                {(delivery.cod_total_amount_required > 0 || delivery.cod_payments && delivery.cod_payments.length > 0 || canEditCodInCurrentState) &&
                <div className="pt-2 border-t space-y-2" style={{ borderColor: 'var(--border-slate-100)' }}>
                  <p className="text-xs font-medium mb-1 flex items-center gap-1" style={{ color: 'var(--text-slate-500)' }}>
                    <DollarSign className="w-3 h-3" /> COD Payment
                  </p>
                  {canEditCodInCurrentState ?
                  <div className="flex flex-col gap-2">
                    <div className="flex items-end gap-2">
                      <div className="flex-1">
                        <Label className="text-xs font-semibold" style={{ color: 'var(--text-slate-700)' }}>
                          Amount to collect
                        </Label>
                        <Input
                          type="number"
                          min="0"
                          step="0.01"
                          value={codAmountRequired}
                          onChange={(e) => setCodAmountRequired(e.target.value === '' ? '' : Number(e.target.value))}
                          disabled={isUpdating}
                          className="h-9 mt-1" />
                      </div>
                      <Button onClick={handleSaveCodAmount} disabled={isUpdating || !hasCodChanges} size="sm" className="bg-emerald-600 hover:bg-emerald-700 text-white h-9 px-3 whitespace-nowrap">
                        Save
                      </Button>
                      {canDeleteCodInCurrentState &&
                      <Button onClick={handleDeleteCodAmount} disabled={isUpdating || Number(delivery?.cod_total_amount_required || 0) <= 0} variant="outline" size="sm" className="h-9 px-3 whitespace-nowrap text-red-600 border-red-300">
                        Delete
                      </Button>
                      }
                    </div>
                  </div> :
                  delivery.cod_total_amount_required > 0 ?
                  <p className="text-sm font-medium" style={{ color: 'var(--text-slate-700)' }}>
                    Required: ${delivery.cod_total_amount_required.toFixed(2)}
                  </p> :
                  null}
                  {delivery.cod_payments && delivery.cod_payments.length > 0 &&
                  <div className="mt-1 space-y-1">
                    {delivery.cod_payments.map((payment, idx) =>
                    <p key={idx} className="text-sm" style={{ color: 'var(--text-slate-600)' }}>
                      {payment.type}: ${payment.amount.toFixed(2)}
                    </p>
                    )}
                  </div>
                  }
                </div>
                }

                {/* Patient Preferences */}
                <div className="flex flex-wrap gap-2 pt-2">
                  {patient.mailbox_ok &&
                  <Badge variant="outline" className="text-xs" style={{ background: 'var(--bg-white)', color: 'var(--text-slate-700)', borderColor: 'var(--border-slate-300)' }}>
                    <Mail className="w-3 h-3 mr-1" /> Mailbox OK
                  </Badge>
                  }
                  {patient.call_upon_arrival &&
                  <Badge variant="outline" className="text-xs" style={{ background: 'var(--bg-white)', color: 'var(--text-slate-700)', borderColor: 'var(--border-slate-300)' }}>
                    <Phone className="w-3 h-3 mr-1" /> Call on Arrival
                  </Badge>
                  }
                  {patient.ring_bell && !patient.dont_ring_bell &&
                  <Badge variant="outline" className="text-xs" style={{ background: 'var(--bg-white)', color: 'var(--text-slate-700)', borderColor: 'var(--border-slate-300)' }}>
                    <Bell className="w-3 h-3 mr-1" /> Ring Bell
                  </Badge>
                  }
                  {patient.dont_ring_bell &&
                  <Badge variant="outline" className="text-xs" style={{ background: 'var(--bg-white)', color: '#ea580c', borderColor: '#fdba74' }}>
                    <BellOff className="w-3 h-3 mr-1" /> Don't Ring
                  </Badge>
                  }
                  {patient.back_door &&
                  <Badge variant="outline" className="text-xs" style={{ background: 'var(--bg-white)', color: 'var(--text-slate-700)', borderColor: 'var(--border-slate-300)' }}>
                    <Home className="w-3 h-3 mr-1" /> Back Door
                  </Badge>
                  }
                </div>
              </div>

              {/* RIGHT column: Patient Notes + Driver Notes */}
              {(patient.notes || delivery.delivery_notes) &&
              <div className="w-[40%] flex-shrink-0 space-y-3">
                {patient.notes &&
                <div>
                  <p className="text-xs font-medium mb-1 flex items-center gap-1" style={{ color: 'var(--text-slate-500)' }}>
                    <StickyNote className="w-3 h-3" /> Patient Notes
                  </p>
                  <p className="text-sm" style={{ color: 'var(--text-slate-700)' }}>{patient.notes}</p>
                </div>
                }
                {delivery.delivery_notes &&
                <div>
                  <p className="text-xs font-medium mb-1 flex items-center gap-1" style={{ color: 'var(--text-slate-500)' }}>
                    <StickyNote className="w-3 h-3" /> Driver Notes
                  </p>
                  <p className="text-sm" style={{ color: 'var(--text-slate-700)' }}>{delivery.delivery_notes}</p>
                </div>
                }
              </div>
              }
            </div> :

            <p className="text-sm" style={{ color: 'var(--text-slate-500)' }}>Patient information not available</p>
            }

            {/* Status & Timing */}
            {canEdit && typeof onStatusUpdate === 'function' &&
            <div className="pt-2 border-t" style={{ borderColor: 'var(--border-slate-100)' }}>
                <p className="text-xs font-medium mb-2" style={{ color: 'var(--text-slate-500)' }}>
                  Status & Timing
                </p>
                <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_auto] gap-2 items-end">

                  <div className="min-w-0 w-full space-y-1">
                    <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>
                      {isPickup ? 'Pickup Status' : 'Delivery Status'}
                    </Label>
                    <Select value={editableStatus} onValueChange={handleStatusChange} disabled={isUpdating || canEditTimeWindows || (isDriverUser && isRouteCompleted(delivery, allDeliveries))}>
                      <SelectTrigger className="h-9">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="z-[10030]">
                        {isPickup ?
                      <>
                            <SelectItem value="en_route">En Route</SelectItem>
                            <SelectItem value="completed">Completed</SelectItem>
                            <SelectItem value="cancelled">Cancelled</SelectItem>
                          </> :

                      <>
                            <SelectItem value="pending">Pending</SelectItem>
                            <SelectItem value="in_transit">In Transit</SelectItem>
                            <SelectItem value="completed">Completed</SelectItem>
                            <SelectItem value="failed">Failed</SelectItem>
                            <SelectItem value="cancelled">Cancelled</SelectItem>
                          </>
                      }
                      </SelectContent>
                    </Select>
                  </div>

                  {showTimeWindowEditors &&
                <>
                      <div className="min-w-0 w-full space-y-1">
                        <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>
                          Start
                        </Label>
                        <div className="relative">
                          <Input type="time" value={deliveryTimeStart} onChange={(e) => setDeliveryTimeStart(e.target.value)} onKeyDown={handleTimeFieldKeyDown} disabled={isUpdating || (isDriverUser && isRouteCompleted(delivery, allDeliveries))} className={`h-9 text-sm ${showDesktopClearButtons ? 'pr-8 stop-details-time-input-desktop' : ''}`} />
                          {showDesktopClearButtons && deliveryTimeStart &&
                      <button type="button" onClick={() => setDeliveryTimeStart('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600" disabled={isUpdating}>
                              <X className="w-4 h-4" />
                            </button>
                      }
                        </div>
                      </div>
                      <div className="min-w-0 w-full space-y-1">
                        <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>
                          End
                        </Label>
                        <div className="relative">
                          <Input type="time" value={deliveryTimeEnd} onChange={(e) => setDeliveryTimeEnd(e.target.value)} onKeyDown={handleTimeFieldKeyDown} disabled={isUpdating || (isDriverUser && isRouteCompleted(delivery, allDeliveries))} className={`h-9 text-sm ${showDesktopClearButtons ? 'pr-8 stop-details-time-input-desktop' : ''}`} />
                          {showDesktopClearButtons && deliveryTimeEnd &&
                      <button type="button" onClick={() => setDeliveryTimeEnd('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600" disabled={isUpdating}>
                              <X className="w-4 h-4" />
                            </button>
                      }
                        </div>
                      </div>
                    </>
                }

                  {isCompletionEditStatus &&
                <>
                      <div className="min-w-0 w-full space-y-1">
                        <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>
                          Completion
                        </Label>
                        <div className="relative">
                        <Input ref={completionTimeRef} type="time" value={completionTime} onChange={(e) => setCompletionTime(e.target.value)} onKeyDown={handleTimeFieldKeyDown} disabled={isUpdating || (isDriverUser && isRouteCompleted(delivery, allDeliveries))} className={`h-9 text-sm ${showDesktopClearButtons ? 'pr-8 stop-details-time-input-desktop' : ''}`} />
                        {showDesktopClearButtons && completionTime &&
                      <button type="button" onClick={() => setCompletionTime('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600" disabled={isUpdating}>
                            <X className="w-4 h-4" />
                          </button>
                      }
                      </div>
                      </div>
                      <div className="min-w-0 w-full space-y-1 opacity-0 pointer-events-none" aria-hidden="true">
                        <Label className="text-sm font-semibold">End</Label>
                        <Input type="time" value="" readOnly className="h-9 text-sm" />
                      </div>
                    </>
                }

                  {!(showTimeWindowEditors || isCompletionEditStatus) &&
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
                }

                  <Button onClick={handleApplyStatusTiming} disabled={isUpdating || !hasStatusTimingChanges || (isDriverUser && isRouteCompleted(delivery, allDeliveries))} size="sm" className="bg-emerald-600 hover:bg-emerald-700 text-white h-9 px-3 whitespace-nowrap">
                    Apply
                  </Button>
                </div>
              </div>
            }
            
            {/* Quick complete/fail buttons for drivers */}
            {canManageStop && currentUser?.app_roles?.includes('driver') && !isCompleted &&
            <div className="flex gap-2 pt-2">
              <Button
                onClick={() => onStatusUpdate(delivery.id, 'completed')}
                className="bg-emerald-600 hover:bg-emerald-700 h-8 w-8 p-0"
                size="icon"
                title="Complete"
                aria-label="Complete delivery">
                <CheckCircle className="w-4 h-4" />
              </Button>
              <Button
                onClick={() => onStatusUpdate(delivery.id, 'failed')}
                variant="destructive"
                className="h-8 w-8 p-0"
                size="icon"
                title="Failed"
                aria-label="Mark delivery failed">
                <XCircle className="w-4 h-4" />
              </Button>
            </div>
            }
          </CardContent>
        </Card>

        {/* POD + Barcodes side by side */}
        {(canViewProofOfDelivery || delivery?.receipt_barcode_values?.length > 0 || delivery?.barcode_values?.length > 0) &&
        <div className="flex gap-2 items-start">

          {/* Proof of Delivery - LEFT */}
          {canViewProofOfDelivery &&
          <Card className="flex-1 min-w-0" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold flex items-center gap-2" style={{ color: 'var(--text-slate-700)' }}>
                <Image className="w-4 h-4" />
                Proof of Delivery
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {/* Signature */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <p className="text-xs font-medium flex items-center gap-1" style={{ color: 'var(--text-slate-500)' }}>
                    <FileSignature className="w-3 h-3" /> Signature
                  </p>
                  {!isCompleted && canEditProofOfDelivery &&
                  <div className="flex gap-1">
                    <Button onClick={() => setShowSignatureCapture(true)} disabled={isUpdating}
                      className={`text-xs whitespace-nowrap h-7 px-2 ${hasSignature ? 'bg-emerald-600 hover:bg-emerald-700 text-white' : ''}`}
                      style={!hasSignature ? { background: 'var(--bg-slate-100)', color: 'var(--text-slate-700)', border: '1px solid var(--border-slate-300)' } : {}}
                      size="sm">
                      <FileSignature className="w-3 h-3 mr-1" />
                      {hasSignature ? 'Re-Capture' : 'Capture'}
                    </Button>
                    {hasSignature &&
                    <Button onClick={clearSignature} disabled={isUpdating} variant="outline" size="sm" className="h-7 px-2 text-xs"
                      style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-700)' }}>
                      <RotateCcw className="w-3 h-3" />
                    </Button>
                    }
                  </div>
                  }
                </div>
                {delivery.signature_image_url ?
                <div className="border rounded-lg overflow-hidden cursor-pointer hover:opacity-80 transition-opacity"
                  style={{ borderColor: 'var(--border-slate-200)' }}
                  onClick={() => setViewingImage({ url: delivery.signature_image_url, title: 'Customer Signature' })}>
                  <img src={delivery.signature_image_url} alt="Customer Signature"
                    className="w-full h-auto max-h-24 object-contain" style={{ background: 'var(--bg-white)' }} />
                </div> :
                delivery.signature_needed ?
                <div className="text-center py-3 border rounded-lg" style={{ borderColor: 'var(--border-slate-200)', background: 'var(--bg-slate-50)' }}>
                  <FileSignature className="w-6 h-6 mx-auto mb-1 opacity-30" style={{ color: 'var(--text-slate-400)' }} />
                  <p className="text-xs" style={{ color: 'var(--text-slate-500)' }}>Not captured yet</p>
                </div> :
                <div className="text-center py-3 border rounded-lg border-dashed" style={{ borderColor: 'var(--border-slate-200)' }}>
                  <p className="text-xs" style={{ color: 'var(--text-slate-400)' }}>No signature</p>
                </div>
                }
              </div>

              {/* Proof Photos */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <p className="text-xs font-medium flex items-center gap-1" style={{ color: 'var(--text-slate-500)' }}>
                    <Image className="w-3 h-3" /> Photos {delivery.proof_photo_urls?.length > 0 ? `(${delivery.proof_photo_urls.length})` : ''}
                  </p>
                  {!isCompleted && canEditProofOfDelivery &&
                  <Button onClick={() => setShowPhotoCapture(true)} disabled={isUpdating}
                    className={`text-xs whitespace-nowrap h-7 px-2 ${hasPhotos ? 'bg-emerald-600 hover:bg-emerald-700 text-white' : ''}`}
                    style={!hasPhotos ? { background: 'var(--bg-slate-100)', color: 'var(--text-slate-700)', border: '1px solid var(--border-slate-300)' } : {}}
                    size="sm">
                    <Camera className="w-3 h-3 mr-1" />
                    {hasPhotos ? 'Add' : 'Capture'}
                  </Button>
                  }
                </div>
                {delivery.proof_photo_urls && delivery.proof_photo_urls.length > 0 ?
                <div className="grid grid-cols-2 gap-1">
                  {delivery.proof_photo_urls.map((url, index) =>
                  <div key={index} className="relative border rounded-lg overflow-hidden group" style={{ borderColor: 'var(--border-slate-200)' }}>
                    <img src={url} alt={`Proof photo ${index + 1}`}
                      className="w-full h-20 object-cover cursor-pointer hover:opacity-90 transition-opacity"
                      onClick={() => setViewingImage({ url, title: `Proof Photo ${index + 1}` })} />
                    <button onClick={(e) => {e.stopPropagation();deletePhoto(index);}} disabled={isUpdating}
                      className="absolute top-1 right-1 rounded-full w-5 h-5 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity disabled:opacity-50"
                      style={{ background: '#dc2626', color: '#ffffff' }}>
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                  )}
                </div> :
                <div className="text-center py-3 border rounded-lg border-dashed" style={{ borderColor: 'var(--border-slate-200)' }}>
                  <p className="text-xs" style={{ color: 'var(--text-slate-400)' }}>No photos</p>
                </div>
                }
              </div>
            </CardContent>
          </Card>
          }

          {/* Barcodes - RIGHT */}
          {(delivery?.receipt_barcode_values?.length > 0 || delivery?.barcode_values?.length > 0) &&
          <Card className="flex-1 min-w-0" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-semibold" style={{ color: 'var(--text-slate-700)' }}>
                  Barcodes
                </CardTitle>
                {delivery?.barcode_values?.length > 0 &&
                  <span className="text-xs font-medium" style={{ color: 'var(--text-slate-500)' }}>Rx ({delivery.barcode_values.length})</span>
                }
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {delivery?.receipt_barcode_values?.length > 0 &&
              <div>
                <p className="text-xs font-medium mb-2" style={{ color: 'var(--text-slate-500)' }}>
                  Receipt ({delivery.receipt_barcode_values.length})
                </p>
                <div className="flex flex-col gap-2">
                  {delivery.receipt_barcode_values.map((val, idx) =>
                  <div key={`rb-${idx}`} className="border rounded-md p-2 cursor-pointer transition-colors"
                    style={{ borderColor: 'var(--border-slate-200)', background: 'var(--bg-white)' }}
                    onClick={() => setBarcodePreview({ value: val, isRx: false })}>
                    <BarcodeThumb value={val} />
                  </div>
                  )}
                </div>
              </div>
              }
              {delivery?.barcode_values?.length > 0 &&
              <div>
                <div className="flex flex-col gap-2">
                  {delivery.barcode_values.map((val, idx) =>
                  <div key={`rx-${idx}`} className="border rounded-md p-2 cursor-pointer transition-colors"
                    style={{ borderColor: 'var(--border-slate-200)', background: 'var(--bg-white)' }}
                    onClick={() => setBarcodePreview({ value: val, isRx: true })}>
                    <BarcodeThumb value={val} isRx={true} />
                    <p className="mt-1 text-[11px] text-center text-slate-500 font-mono font-semibold">{String(val).slice(0, 8)}</p>
                  </div>
                  )}
                </div>
              </div>
              }
            </CardContent>
          </Card>
          }
        </div>
        }
      </div>

      {/* Action Buttons - Drivers */}
      {currentUser?.app_roles?.includes('driver') && ['completed', 'failed', 'cancelled'].includes(delivery.status) && onRestart && !isRouteCompleted(delivery, allDeliveries) &&
      <div className="flex-shrink-0 p-4 border-t" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
          <div className="flex gap-2">
            <Button
            onClick={() => onRestart(delivery.id)}
            className="flex-1 bg-blue-600 hover:bg-blue-700 text-white"
            disabled={isUpdating}>
            
              <RotateCcw className="w-4 h-4 mr-2" />
              Restart
            </Button>
          </div>
        </div>
      }

      {showSignatureCapture &&
      <SignatureCapture
        onSave={handleSignatureSave}
        onCancel={() => setShowSignatureCapture(false)}
        customerName={patient?.full_name || delivery.patient_name}
        isSaved={hasSignature} />

      }

      {showPhotoCapture &&
      <PhotoCapture
        onSave={handlePhotosSave}
        onCancel={() => setShowPhotoCapture(false)}
        maxPhotos={3} />

      }

      {viewingImage &&
      <ImageViewer
        imageUrl={viewingImage.url}
        title={viewingImage.title}
        onClose={() => setViewingImage(null)} />

      }

      {barcodePreview &&
      <BarcodeOverlay value={barcodePreview.value} isRx={barcodePreview.isRx} onClose={() => setBarcodePreview(null)} />
      }
      </div>);

}