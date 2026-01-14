import React from "react";
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
  FileSignature
} from "lucide-react";
import { format } from "date-fns";
import { formatPhoneNumber } from "../utils/phoneFormatter";

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
  if (!delivery) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-6 text-center" style={{ background: 'var(--bg-slate-50)' }}>
        <Package className="w-16 h-16 mb-4 opacity-30" style={{ color: 'var(--text-slate-400)' }} />
        <p className="text-lg font-medium" style={{ color: 'var(--text-slate-500)' }}>Select a stop to view details</p>
        <p className="text-sm mt-1" style={{ color: 'var(--text-slate-400)' }}>Click on a stop card to see patient and delivery information</p>
      </div>
    );
  }

  const isPickup = !delivery.patient_id;
  const status = statusConfig[delivery.status] || statusConfig.pending;
  const StatusIcon = status.icon;

  const canEdit = currentUser && (
    currentUser.app_roles?.includes('admin') || 
    currentUser.app_roles?.includes('dispatcher')
  );

  const isCompleted = ['completed', 'failed', 'cancelled', 'returned'].includes(delivery.status);

  return (
    <div className="h-full flex flex-col overflow-hidden" style={{ background: 'var(--bg-slate-50)' }}>
      {/* Header */}
      <div className="flex-shrink-0 p-4 border-b flex items-center justify-between" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={onClose} className="lg:hidden">
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <h2 className="text-lg font-bold" style={{ color: 'var(--text-slate-900)' }}>Stop Details</h2>
        </div>
        <Badge className={`${status.color} border`}>
          <StatusIcon className="w-3 h-3 mr-1" />
          {status.label}
        </Badge>
      </div>

      {/* Scrollable Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Patient Info Card */}
        <Card style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2" style={{ color: 'var(--text-slate-700)' }}>
              <User className="w-4 h-4" />
              {isPickup ? 'Store Pickup' : 'Patient Information'}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {isPickup ? (
              <>
                <div>
                  <p className="text-lg font-bold" style={{ color: 'var(--text-slate-900)' }}>
                    {store?.name || 'Store Pickup'}
                  </p>
                  {store?.abbreviation && (
                    <Badge variant="outline" className="mt-1" style={{ borderColor: store?.color || 'var(--border-slate-300)', color: store?.color || 'var(--text-slate-600)' }}>
                      {store.abbreviation}
                    </Badge>
                  )}
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
                <div>
                  <p className="text-lg font-bold" style={{ color: 'var(--text-slate-900)' }}>
                    {patient.full_name || delivery.patient_name || 'Unknown Patient'}
                  </p>
                  {patient.unit_number && (
                    <Badge variant="secondary" className="mt-1">Unit {patient.unit_number}</Badge>
                  )}
                </div>
                
                {patient.address && (
                  <div className="flex items-start gap-2">
                    <MapPin className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: 'var(--text-slate-400)' }} />
                    <div>
                      <p className="text-sm" style={{ color: 'var(--text-slate-600)' }}>{patient.address}</p>
                      {patient.distance_from_store && (
                        <p className="text-xs mt-0.5" style={{ color: 'var(--text-slate-400)' }}>
                          {patient.distance_from_store.toFixed(1)} km from store
                        </p>
                      )}
                    </div>
                  </div>
                )}

                {patient.phone && (
                  <div className="flex items-center gap-2">
                    <Phone className="w-4 h-4" style={{ color: 'var(--text-slate-400)' }} />
                    <a href={`tel:${patient.phone}`} className="text-sm text-blue-600 hover:underline">
                      {formatPhoneNumber(patient.phone)}
                    </a>
                  </div>
                )}

                {patient.phone_secondary && (
                  <div className="flex items-center gap-2">
                    <Phone className="w-4 h-4" style={{ color: 'var(--text-slate-400)' }} />
                    <a href={`tel:${patient.phone_secondary}`} className="text-sm text-blue-600 hover:underline">
                      {formatPhoneNumber(patient.phone_secondary)} (Alt)
                    </a>
                  </div>
                )}

                {/* Patient Preferences */}
                <div className="flex flex-wrap gap-2 pt-2">
                  {patient.mailbox_ok && (
                    <Badge variant="outline" className="text-xs">
                      <Mail className="w-3 h-3 mr-1" /> Mailbox OK
                    </Badge>
                  )}
                  {patient.call_upon_arrival && (
                    <Badge variant="outline" className="text-xs">
                      <Phone className="w-3 h-3 mr-1" /> Call on Arrival
                    </Badge>
                  )}
                  {patient.ring_bell && !patient.dont_ring_bell && (
                    <Badge variant="outline" className="text-xs">
                      <Bell className="w-3 h-3 mr-1" /> Ring Bell
                    </Badge>
                  )}
                  {patient.dont_ring_bell && (
                    <Badge variant="outline" className="text-xs text-orange-600 border-orange-300">
                      <BellOff className="w-3 h-3 mr-1" /> Don't Ring
                    </Badge>
                  )}
                  {patient.back_door && (
                    <Badge variant="outline" className="text-xs">
                      <Home className="w-3 h-3 mr-1" /> Back Door
                    </Badge>
                  )}
                </div>

                {patient.notes && (
                  <div className="pt-2 border-t" style={{ borderColor: 'var(--border-slate-100)' }}>
                    <p className="text-xs font-medium mb-1" style={{ color: 'var(--text-slate-500)' }}>Patient Notes:</p>
                    <p className="text-sm" style={{ color: 'var(--text-slate-700)' }}>{patient.notes}</p>
                  </div>
                )}
              </>
            ) : (
              <p className="text-sm" style={{ color: 'var(--text-slate-500)' }}>Patient information not available</p>
            )}
          </CardContent>
        </Card>

        {/* Delivery Info Card */}
        <Card style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2" style={{ color: 'var(--text-slate-700)' }}>
              <Package className="w-4 h-4" />
              Delivery Information
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* Store Info */}
            {store && !isPickup && (
              <div className="flex items-center gap-2">
                <Building2 className="w-4 h-4" style={{ color: 'var(--text-slate-400)' }} />
                <span className="text-sm" style={{ color: 'var(--text-slate-600)' }}>{store.name}</span>
                {store.abbreviation && (
                  <Badge 
                    variant="outline" 
                    className="text-xs"
                    style={{ borderColor: store.color || 'var(--border-slate-300)', color: store.color || 'var(--text-slate-600)' }}
                  >
                    {store.abbreviation}
                  </Badge>
                )}
              </div>
            )}

            {/* Time Window */}
            {(delivery.delivery_time_start || delivery.delivery_time_eta) && (
              <div className="flex items-center gap-2">
                <Clock className="w-4 h-4" style={{ color: 'var(--text-slate-400)' }} />
                <span className="text-sm" style={{ color: 'var(--text-slate-600)' }}>
                  {delivery.delivery_time_eta && (
                    <span className="font-medium text-blue-600">ETA: {delivery.delivery_time_eta}</span>
                  )}
                  {delivery.delivery_time_eta && delivery.delivery_time_start && ' • '}
                  {delivery.delivery_time_start && (
                    <span>Window: {delivery.delivery_time_start}{delivery.delivery_time_end ? ` - ${delivery.delivery_time_end}` : ''}</span>
                  )}
                </span>
              </div>
            )}

            {/* Tracking & Prescription */}
            <div className="flex flex-wrap gap-2">
              {delivery.tracking_number && (
                <Badge variant="secondary" className="font-mono">
                  TR# {delivery.tracking_number}
                </Badge>
              )}
              {delivery.prescription_number && (
                <Badge variant="outline">
                  RX# {delivery.prescription_number}
                </Badge>
              )}
              {delivery.stop_order && (
                <Badge variant="outline">
                  Stop #{delivery.stop_order}
                </Badge>
              )}
            </div>

            {/* Delivery Flags */}
            <div className="flex flex-wrap gap-2 pt-2">
              {delivery.fridge_item && (
                <Badge className="bg-blue-100 text-blue-800 border-blue-300">
                  <Thermometer className="w-3 h-3 mr-1" /> Fridge Item
                </Badge>
              )}
              {delivery.oversized && (
                <Badge className="bg-purple-100 text-purple-800 border-purple-300">
                  <Package className="w-3 h-3 mr-1" /> Oversized
                </Badge>
              )}
              {delivery.signature_needed && (
                <Badge className="bg-amber-100 text-amber-800 border-amber-300">
                  <Pencil className="w-3 h-3 mr-1" /> Signature Required
                </Badge>
              )}
              {delivery.cod_total_amount_required > 0 && (
                <Badge className="bg-green-100 text-green-800 border-green-300">
                  <DollarSign className="w-3 h-3 mr-1" /> COD: ${delivery.cod_total_amount_required}
                </Badge>
              )}
              {delivery.first_delivery && (
                <Badge className="bg-pink-100 text-pink-800 border-pink-300">
                  First Delivery
                </Badge>
              )}
            </div>

            {/* Delivery Notes */}
            {delivery.delivery_notes && (
              <div className="pt-2 border-t" style={{ borderColor: 'var(--border-slate-100)' }}>
                <div className="flex items-start gap-2">
                  <StickyNote className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: 'var(--text-slate-400)' }} />
                  <div>
                    <p className="text-xs font-medium mb-1" style={{ color: 'var(--text-slate-500)' }}>Delivery Notes:</p>
                    <p className="text-sm" style={{ color: 'var(--text-slate-700)' }}>{delivery.delivery_notes}</p>
                  </div>
                </div>
              </div>
            )}

            {/* Delivery Instructions */}
            {delivery.delivery_instructions && (
              <div className="pt-2 border-t" style={{ borderColor: 'var(--border-slate-100)' }}>
                <p className="text-xs font-medium mb-1" style={{ color: 'var(--text-slate-500)' }}>Instructions:</p>
                <p className="text-sm" style={{ color: 'var(--text-slate-700)' }}>{delivery.delivery_instructions}</p>
              </div>
            )}

            {/* Actual Delivery Time */}
            {delivery.actual_delivery_time && (
              <div className="pt-2 border-t" style={{ borderColor: 'var(--border-slate-100)' }}>
                <p className="text-xs" style={{ color: 'var(--text-slate-500)' }}>
                  Completed at: {new Date(delivery.actual_delivery_time).toLocaleString()}
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Action Buttons */}
      {canEdit && (
        <div className="flex-shrink-0 p-4 border-t space-y-2" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
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
          
          <div className="flex gap-2">
            {isCompleted && onRestart && (
              <Button 
                onClick={() => onRestart(delivery.id)}
                variant="outline"
                className="flex-1"
              >
                <RotateCcw className="w-4 h-4 mr-2" />
                Retry
              </Button>
            )}
            <Button 
              onClick={() => onEditDelivery(delivery)}
              variant="outline"
              className="flex-1"
            >
              <Pencil className="w-4 h-4 mr-2" />
              Edit
            </Button>
            <Button 
              onClick={() => {
                if (confirm('Are you sure you want to delete this delivery?')) {
                  onDeleteDelivery(delivery.id);
                }
              }}
              variant="outline"
              className="text-red-600 hover:bg-red-50"
            >
              <Trash2 className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}