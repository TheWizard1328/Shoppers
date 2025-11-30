import React, { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import {
  Clock,
  MapPin,
  Phone,
  User, // Added User icon import as per outline requirement
  Edit,
  Trash2,
  RotateCcw,
  Undo2,
  GripVertical,
  Truck // Added Truck icon import
} from "lucide-react";
import { format } from "date-fns";
import { formatPhoneNumber } from "../utils/formatters"; // Using existing utility path
import { getStoreColor, hexToRgba } from "../utils/colorGenerator";
import { getDriverDisplayName } from "../utils/driverUtils";
import { shouldShowStoreBadges } from "../utils/userRoles";

function DeliveryCard({
  delivery,
  patient,
  store, // Now passed directly as a prop
  onEdit,
  onDelete,
  onStatusUpdate,
  onNotesUpdate,
  onCODUpdate,
  onRetry,
  onReturn,
  statusConfig = {},
  canEdit = false, // Existing prop, will be superseded by canEditDelivery
  canDelete = false, // Existing prop, will be superseded by canDeleteDelivery
  stopOrder,
  dragHandleProps,
  allDeliveries = [],
  selectedDate,
  isProjected = false,
  currentUser
}) {
  const [isUpdating, setIsUpdating] = useState(false);
  const [editingPatientNotes, setEditingPatientNotes] = useState(false);
  const [localPatientNotes, setLocalPatientNotes] = useState((patient?.notes || "").replace(/ - /g, '\n'));
  const [localDriverNotes, setLocalDriverNotes] = useState(delivery?.delivery_notes || "");
  const [isProjectedExpanded, setIsProjectedExpanded] = useState(false);

  const isPickup = delivery.patient_id === null;

  const completedStatuses = ['completed', 'failed', 'cancelled'];
  const isCompleted = completedStatuses.includes(delivery.status) || (isPickup && delivery.status === 'in_transit');

  const canBeDragged = !isCompleted && !isProjected; // Projected cards cannot be dragged

  const canEditDelivery = !isProjected && (!isCompleted || currentUser?.app_role === 'admin' || currentUser?.app_role === 'dispatcher');
  // const canDeleteDelivery = !isProjected && (currentUser?.app_role === 'admin' || currentUser?.app_role === 'dispatcher'); // This variable is no longer needed with the simplified delete condition

  if (!delivery || (!patient && !isPickup)) {
    return (
      <Card className="border-red-200 bg-red-50 w-full">
        <CardContent className="p-4">
          <div className="flex items-center gap-2 text-red-600">
            <span className="text-sm">Missing delivery or patient data</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  const getStatusBadge = (status) => {
    // THIS FUNCTION IS NO LONGER USED FOR PROJECTED CARDS
    const statusInfo = statusConfig[status];
    let color = statusInfo?.color || 'bg-slate-100 text-slate-800';
    let label = statusInfo?.label || status?.toUpperCase() || 'UNKNOWN';

    // Special handling for pickup completion
    if (isPickup && status === 'completed') {
      label = 'COMPLETE';
      color = 'bg-green-100 text-green-800';
    }

    return (
      <Badge className={`${color} text-xs font-medium px-2 py-1 rounded-md`}>
        {label}
      </Badge>
    );
  };

  // Get store color for card border and badges
  const storeColor = store ? getStoreColor(store) : '#71717A';
  const storeBgColor = hexToRgba(storeColor, 0.1);
  const storeTextColor = storeColor;

  const isReturned = delivery.delivery_notes && delivery.delivery_notes.toLowerCase().includes('return');

  // Redact completed info for non-admins/dispatchers
  const shouldRedact = !isProjected && isCompleted &&
    !['admin', 'dispatcher'].includes(currentUser?.app_role) &&
    !['admin', 'dispatcher'].includes(currentUser?.role);

  let displayName, displayAddress;

  if (isPickup) {
    displayName = `${store?.name || 'Store'} Pickup`;
    displayAddress = store?.address || 'Store address';
  } else if (patient) {
    displayName = shouldRedact && patient.full_name
      ? patient.full_name.split(' ')[0] + ' *****'
      : patient.full_name;

    displayAddress = shouldRedact
      ? (patient.address ? patient.address.split(' ')[0] + ' *****' : 'Address hidden')
      : (delivery.delivery_address || patient.address) + (delivery.unit_number ? ` #${delivery.unit_number}` : (patient.unit_number ? ` #${patient.unit_number}` : ''));
  } else {
    displayName = "Unknown Delivery";
    displayAddress = delivery.delivery_address || "No address";
  }

  const displayPhone = isPickup ? formatPhoneNumber(store?.phone) : ((shouldRedact && patient?.phone) ? '****-****-' + patient.phone.slice(-4) : formatPhoneNumber(patient?.phone));

  const hasReturnInNotes = patient?.notes?.toLowerCase().includes('return');

  const hasLaterSuccessfulDelivery = allDeliveries.some(d =>
    d.id !== delivery.id &&
    d.patient_id === delivery.patient_id &&
    d.status === 'completed' &&
    (d.delivery_date > delivery.delivery_date ||
      (d.delivery_date === delivery.delivery_date && (d.delivery_time_start || '00:00') > (delivery.delivery_time_start || '00:00')))
  );

  // Check if there's already a return delivery for this patient
  const hasReturnDelivery = allDeliveries.some(d =>
    d.id !== delivery.id &&
    d.patient_id === delivery.patient_id &&
    d.delivery_notes && d.delivery_notes.toLowerCase().includes('return')
  );

  // Only show retry/return for today's failed deliveries
  const isToday = selectedDate && delivery.delivery_date && format(selectedDate, 'yyyy-MM-dd') === delivery.delivery_date;
  const showRetryReturn = !isProjected && ['failed'].includes(delivery.status) && !hasReturnInNotes && !hasLaterSuccessfulDelivery && !hasReturnDelivery && isToday;
  const showRetryButton = showRetryReturn && !hasLaterSuccessfulDelivery;
  const showReturnButton = showRetryReturn && !hasReturnDelivery;

  const handlePatientNotesBlur = async () => {
    const notesToSave = localPatientNotes.replace(/\n/g, ' - ');
    if (notesToSave !== (patient?.notes || "") && onNotesUpdate && patient?.id) {
      await onNotesUpdate('patient', patient.id, notesToSave);
    }
    setEditingPatientNotes(false);
  };

  const handleDriverNotesBlur = async () => {
    if (localDriverNotes !== (delivery?.delivery_notes || "") && onNotesUpdate && delivery.id) {
        await onNotesUpdate(delivery.id, localDriverNotes);
    }
  };

  // Construct the display tracking number
  const storeAbbr = store?.abbreviation || '';
  let displayTrackingNumber = delivery.tracking_number || '';
  if (storeAbbr && displayTrackingNumber && !displayTrackingNumber.startsWith(storeAbbr)) {
      displayTrackingNumber = `${storeAbbr}${displayTrackingNumber}`;
  }

  const getTimeDisplay = () => {
    if (isCompleted && !isProjected) {
      return null; // Don't show ETA for completed items (unless projected)
    }
    const time = delivery.delivery_time_start;
    if (!time) return null;

    return (
      <div className="flex items-center gap-1 text-xs">
        <Clock className="w-3 h-3 flex-shrink-0 text-slate-600" />
        <span className="font-medium text-slate-700">ETA:</span>
        <span className="text-slate-600">{time}</span>
      </div>
    );
  };

  const getCompletionTimeDisplay = () => {
    if (isProjected) return null; // Don't show completion time for projected cards

    if (delivery.status === 'completed' && delivery.actual_delivery_time) {
      return (
        <div className="flex items-center gap-1 text-xs text-green-600 font-medium">
          <Clock className="w-3 h-3" />
          <span>Completed: {format(new Date(delivery.actual_delivery_time), 'HH:mm')}</span>
        </div>
      );
    } else if (['failed', 'cancelled'].includes(delivery.status) && delivery.actual_delivery_time) {
      const statusText = isReturned ? 'Returned' : (delivery.status === 'failed' ? 'Failed' : 'Cancelled');
      return (
        <div className="flex items-center gap-1 text-xs text-red-600 font-medium">
          <Clock className="w-3 h-3" />
          <span>{statusText}: {format(new Date(delivery.actual_delivery_time), 'HH:mm')}</span>
        </div>
      );
    }
    return null;
  };

  // Use same border styling for both projected and regular cards
  const cardBorderClass = 'border-2';
  const cardStyle = isPickup ? { borderColor: storeColor } : { borderColor: 'transparent' };

  // Get stop order badge color
  const getStopOrderBadgeColor = () => {
    if (['completed'].includes(delivery.status)) {
      return { backgroundColor: '#10b981', color: 'white' };
    } else if (['failed', 'cancelled'].includes(delivery.status) || isReturned) {
      return { backgroundColor: '#ef4444', color: 'white' };
    } else {
      return { backgroundColor: storeBgColor, color: storeTextColor };
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      className="h-full w-full"
    >
      <Card
        className={`relative flex flex-col h-full w-full min-w-0 overflow-hidden transition-all duration-300 shadow-md ${isCompleted ? 'bg-slate-50' : 'bg-white'} ${patient?.status === 'inactive' ? 'opacity-60' : ''} ${cardBorderClass}`}
        style={cardStyle}
        onClick={isProjected && isPickup ? () => setIsProjectedExpanded(!isProjectedExpanded) : undefined}
      >
        <CardContent className="p-3 flex flex-col flex-grow min-w-0">
          <div className="flex justify-between items-start mb-1">
            <div className="flex-1 flex items-center gap-2 min-w-0">
              {/* Stop Order Badge with color coding */}
              <div
                className="text-sm font-bold rounded-md w-6 h-6 flex items-center justify-center flex-shrink-0 text-xs"
                style={getStopOrderBadgeColor()}
              >
                {stopOrder || '?'}
              </div>
              <h3 className="font-semibold text-slate-900 text-sm truncate leading-tight min-w-0 flex-1">
                {displayName}
              </h3>
            </div>

            <div className="flex flex-col items-end gap-1 ml-2 flex-shrink-0">
              {/* Drag Handle - only show if can be dragged */}
              {canBeDragged && (
                <div
                  {...dragHandleProps}
                  className="cursor-grab hover:cursor-grabbing p-1 text-slate-400 hover:text-slate-600 transition-colors"
                  title="Drag to reorder"
                >
                  <GripVertical className="w-4 h-4" />
                </div>
              )}

              {/* Status Badge and TR# */}
              <div className="flex flex-col items-end gap-1">
                {isProjected ? (
                  <Badge className="bg-gray-200 text-gray-800 text-xs font-medium px-2 py-1 rounded-md">
                    PROJECTED
                  </Badge>
                ) : isPickup ? (
                  getStatusBadge(delivery.status === 'in_transit' ? 'completed' : delivery.status)
                ) : isReturned ? (
                  <Badge className="bg-red-100 text-red-800 text-xs font-medium px-2 py-1 rounded-md">
                    RETURN
                  </Badge>
                ) : (
                  getStatusBadge(delivery.status)
                )}

                {/* TR# Badge */}
                {delivery.tracking_number && shouldShowStoreBadges(currentUser) && (
                  <Badge
                    className="font-mono text-xs"
                    style={{ backgroundColor: storeBgColor, color: storeTextColor }}
                  >
                    {displayTrackingNumber}
                  </Badge>
                )}
              </div>
            </div>
          </div>

          <div className="flex justify-between items-center mb-1">
            <div className="min-w-0 text-xs">
              {getTimeDisplay()}
            </div>
          </div>

          {delivery.delivery_stop_id && (
            <div className="flex justify-end mb-1">
              <Badge variant="outline" className="font-mono text-xs border-slate-400">
                {delivery.delivery_stop_id}
              </Badge>
            </div>
          )}

          <div className="space-y-1 mb-1 min-w-0">
            <div className="flex items-center gap-2 text-xs text-slate-600 min-w-0">
              <MapPin className="w-3 h-3 flex-shrink-0" />
              <span className="truncate min-w-0 flex-1">{displayAddress}</span>
            </div>

            <div className="flex items-center gap-2 text-xs text-slate-600">
              <Phone className="w-3 h-3 flex-shrink-0" />
              <span className="truncate">{displayPhone}</span>
            </div>

            {/* New patient display section added from outline, adjusted for existing redaction logic and context */}
            {patient && !isPickup && (
              <div className="text-xs text-slate-600 space-y-1 mt-2 border-t pt-2 border-slate-100">
                <div className="flex items-center gap-2">
                  <User className="w-3 h-3" />
                  <span className="font-medium">{displayName}</span> {/* Using existing redacted displayName */}
                </div>
                <div className="flex items-center gap-2">
                  <MapPin className="w-3 h-3" />
                  <span>{displayAddress}</span> {/* Using existing redacted displayAddress */}
                </div>
                {patient.phone && (
                  <div className="flex items-center gap-2">
                    <Phone className="w-3 h-3" />
                    <span>{displayPhone}</span> {/* Using existing redacted displayPhone */}
                  </div>
                )}
              </div>
            )}

            {/* Driver Name Display */}
            <div className="flex items-center gap-1.5 text-xs">
              <Truck className="w-3 h-3 text-slate-500" />
              <span className="text-slate-600 font-medium">
                {delivery.driver_name ? delivery.driver_name.split(' ')[0] : 'Unassigned'}
              </span>
            </div>

            {/* Show completion time under phone number */}
            {getCompletionTimeDisplay()}
          </div>

          <div className="flex flex-col gap-2 mb-2">
            {/* Only show status dropdown for non-completed items and non-projected cards */}
            {canEditDelivery && !isCompleted && !isProjected && (
              <Select
                value={delivery.status}
                onValueChange={(value) => onStatusUpdate && onStatusUpdate(delivery.id, value)}
                disabled={isUpdating}
              >
                <SelectTrigger className="w-full h-7 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="Ready For Pickup">Ready For Pickup</SelectItem>
                  <SelectItem value="in_transit">In Transit</SelectItem>
                  <SelectItem value="completed">Completed</SelectItem>
                  <SelectItem value="failed">Failed</SelectItem>
                </SelectContent>
              </Select>
            )}

            {/* COD section - only for patient deliveries, and only if not completed and not projected */}
            {canEditDelivery && !isPickup && !isCompleted && !isProjected && (
              <div className="flex gap-2">
                <Select
                    value={delivery.cod_payment_type || "No Payment"}
                    onValueChange={(value) => onCODUpdate && onCODUpdate(delivery.id, { cod_payment_type: value })}
                    disabled={isUpdating}
                >
                    <SelectTrigger className="flex-1 h-7 text-xs">
                        <SelectValue placeholder="No COD/DOD" />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="No Payment">No COD/DOD</SelectItem>
                        <SelectItem value="Cash">Cash</SelectItem>
                        <SelectItem value="Debit">Debit</SelectItem>
                        <SelectItem value="Credit">Credit</SelectItem>
                        <SelectItem value="Check">Check</SelectItem>
                    </SelectContent>
                </Select>

                {(delivery.cod_payment_type && delivery.cod_payment_type !== 'No Payment') && (
                  <Input
                    type="text"
                    placeholder="0.00"
                    value={delivery.cod_amount ?? ''}
                    onChange={(e) => onCODUpdate && onCODUpdate(delivery.id, { cod_amount: e.target.value })}
                    className="w-16 h-7 text-xs"
                    disabled={isUpdating}
                  />
                )}
              </div>
            )}

            {/* Display COD info for completed deliveries */}
            {!isProjected && isCompleted && delivery.cod_payment_type && delivery.cod_payment_type !== 'No Payment' && (
              <div className="text-right text-xs font-semibold text-slate-700 pr-1">
                {delivery.cod_payment_type}: ${delivery.cod_amount || '0.00'}
              </div>
            )}
          </div>

          <div className="flex-grow"></div>

          {/* Notes Section OR Projected Deliveries List */}
          {isProjected && isPickup && delivery.projected_deliveries ? (
            // Show projected deliveries list instead of notes for projected pickup cards
            <div className={`mb-2 transition-all duration-300 ease-in-out ${isProjectedExpanded ? 'max-h-96' : 'max-h-0 overflow-hidden'}`} onClick={(e) => e.stopPropagation()}>
              <AnimatePresence>
                {isProjectedExpanded && (
                  <motion.div
                    initial={{ opacity: 0, y: -10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    className="mt-2"
                  >
                    <h4 className="text-xs font-medium text-slate-600 mb-2">Projected Deliveries ({delivery.projected_deliveries.length})</h4>
                    <div className="max-h-48 overflow-y-auto bg-slate-50 rounded border">
                      {delivery.projected_deliveries.length === 0 ? (
                        <div className="p-3 text-xs text-slate-500 text-center">
                          No deliveries projected for this store
                        </div>
                      ) : (
                        <div className="text-xs">
                          {/* Header */}
                          <div className="grid grid-cols-12 gap-1 p-2 bg-slate-100 border-b border-slate-200 font-medium text-slate-700">
                            <div className="col-span-1">#</div>
                            <div className="col-span-3">TR#</div>
                            <div className="col-span-5">Patient</div>
                            <div className="col-span-3">Dist</div>
                          </div>
                          {/* Delivery Rows */}
                          {delivery.projected_deliveries.map((projectedDelivery, index) => (
                            <div key={projectedDelivery.id} className={`grid grid-cols-12 gap-1 p-2 border-b border-slate-100 ${index % 2 === 0 ? 'bg-white' : 'bg-slate-50'}`}>
                              <div className="col-span-1 font-medium text-slate-900">
                                {projectedDelivery.stop_order}
                              </div>
                              <div className="col-span-3 font-mono text-slate-700">
                                {projectedDelivery.tracking_number}
                              </div>
                              <div className="col-span-5 text-slate-900 truncate" title={projectedDelivery.patient_name}>
                                {projectedDelivery.patient_name}
                              </div>
                              <div className="col-span-3 text-slate-600">
                                {projectedDelivery.patient_distance ? `${projectedDelivery.patient_distance.toFixed(1)}km` : 'N/A'}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          ) : (
            // Regular notes section for non-projected cards
            <div className="mb-2 grid grid-cols-1 sm:grid-cols-2 gap-2 min-w-0" onClick={(e) => e.stopPropagation()}>
              <div className="flex flex-col min-w-0">
                <h4 className="text-xs font-medium text-slate-600 mb-1">Patient Notes</h4>
                <Textarea
                  value={localPatientNotes}
                  onChange={(e) => setLocalPatientNotes(e.target.value)}
                  onFocus={() => setEditingPatientNotes(true)}
                  onBlur={handlePatientNotesBlur}
                  placeholder="No patient notes"
                  className="text-xs resize-none border-slate-200 h-16 w-full min-w-0"
                  disabled={!canEditDelivery}
                />
              </div>
              <div className="flex flex-col min-w-0">
                <h4 className="text-xs font-medium text-slate-600 mb-1">Driver Notes</h4>
                <Textarea
                  value={localDriverNotes}
                  onChange={(e) => setLocalDriverNotes(e.target.value)}
                  onBlur={handleDriverNotesBlur}
                  placeholder="Add driver notes..."
                  className="text-xs resize-none border-slate-200 h-16 w-full min-w-0"
                  disabled={!canEditDelivery}
                />
              </div>
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex items-center justify-between pt-2 border-t border-slate-100">
            <div className="flex items-center gap-1 flex-wrap">
              {showRetryButton && (
                <Button variant="outline" size="sm" className="text-xs h-6 px-2" onClick={(e) => { e.stopPropagation(); onRetry && onRetry(delivery.id); }} disabled={!canEditDelivery}>
                  <RotateCcw className="w-3 h-3 mr-1"/> Retry
                </Button>
              )}
              {showReturnButton && (
                <Button variant="outline" size="sm" className="text-xs h-6 px-2" onClick={(e) => { e.stopPropagation(); onReturn && onReturn(delivery.id); }} disabled={!canEditDelivery}>
                  <Undo2 className="w-3 h-3 mr-1"/> Return
                </Button>
              )}
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
              {onEdit && canEditDelivery && !isProjected && (
                <Button variant="ghost" size="icon" className="w-6 h-6" onClick={(e) => { e.stopPropagation(); onEdit(delivery); }}>
                  <Edit className="w-3 h-3" />
                </Button>
              )}
              {/* Fix delete button - allow admins and dispatchers to delete */}
              {onDelete && !isProjected && (currentUser?.app_role === 'admin' || currentUser?.app_role === 'dispatcher') && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="w-6 h-6 text-red-500 hover:text-red-700"
                  onClick={(e) => {
                    e.stopPropagation();
                    console.log('Delete button clicked for delivery:', delivery.id);
                    onDelete(delivery.id);
                  }}
                >
                  <Trash2 className="w-3 h-3" />
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}

export default DeliveryCard;