import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Package,
  Calendar,
  Clock,
  User,
  MapPin,
  FileText,
  Phone,
  Mail,
  AlertCircle,
  CheckCircle,
  StickyNote // Import StickyNote icon
} from "lucide-react";
import { format } from "date-fns";
import { formatPhoneNumber } from "../utils/formatters"; // Import the phone formatter

// Helper function to safely format dates
const safeFormatDate = (dateString, formatString) => {
  if (!dateString) return 'N/A';
  try {
    // Attempt to parse the date. Replace hyphens with slashes for Safari compatibility if needed,
    // though new Date() usually handles ISO 8601 with hyphens.
    // The original code already had .replace(/-/g, '/'), so we'll incorporate that logic.
    const date = new Date(dateString.replace(/-/g, '/')); 
    if (isNaN(date.getTime())) return 'N/A'; // Check for "Invalid Date"
    return format(date, formatString);
  } catch (error) {
    console.warn('Error formatting date:', dateString, error);
    return 'N/A';
  }
};

export default function DeliveryDetails({ delivery, patient, statusConfig }) {
  if (!delivery) {
    return (
      <Card className="bg-white border-slate-200 shadow-sm">
        <CardContent className="p-8 text-center">
          <Package className="w-12 h-12 text-slate-300 mx-auto mb-4" />
          <p className="text-slate-500">Select a delivery to view details</p>
        </CardContent>
      </Card>
    );
  }

  const StatusIcon = statusConfig[delivery.status]?.icon || Package;

  const getPriorityColor = (priority) => {
    switch (priority) {
      case 'urgent': return 'bg-red-100 text-red-800';
      case 'high': return 'bg-orange-100 text-orange-800';
      case 'normal': return 'bg-blue-100 text-blue-800';
      case 'low': return 'bg-gray-100 text-gray-800';
      default: return 'bg-blue-100 text-blue-800';
    }
  };

  // NEW: Calculate COD totals
  const hasCOD = delivery.cod_total_amount_required > 0 || 
    (delivery.cod_amount && parseFloat(delivery.cod_amount) > 0);
  
  const codTotalRequired = delivery.cod_total_amount_required || 
    (delivery.cod_amount ? parseFloat(delivery.cod_amount) : 0);
  
  const codPayments = delivery.cod_payments || [];
  const codTotalCollected = codPayments.reduce((sum, payment) => 
    sum + (parseFloat(payment.amount) || 0), 0);
  
  const isCODComplete = codTotalCollected >= codTotalRequired;

  return (
    <div className="space-y-6">
      {/* Delivery Info Card */}
      <Card className="border shadow-sm" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Package className="w-5 h-5 text-emerald-600" />
            <span style={{ color: 'var(--text-slate-900)' }}>Delivery Details</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-semibold text-lg mb-1" style={{ color: 'var(--text-slate-900)' }}>
                {delivery.prescription_details}
              </h3>
              <div className="flex items-center gap-3 text-sm font-mono" style={{ color: 'var(--text-slate-500)' }}>
                {delivery.tracking_number && (
                    <span>#{delivery.tracking_number}</span>
                )}
                {delivery.prescription_number && (
                    <span>Rx: {delivery.prescription_number}</span>
                )}
              </div>
            </div>
            <div className="flex flex-col items-end gap-2">
              <Badge className={`text-xs ${statusConfig[delivery.status]?.color}`}>
                {statusConfig[delivery.status]?.label || delivery.status}
              </Badge>
              <Badge className={`text-xs ${getPriorityColor(delivery.priority)}`}>
                {delivery.priority} priority
              </Badge>
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-center gap-3 text-sm">
              <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: 'var(--bg-slate-100)' }}>
                <Calendar className="w-4 h-4" style={{ color: 'var(--text-slate-600)' }} />
              </div>
              <div>
                <p className="font-medium" style={{ color: 'var(--text-slate-900)' }}>
                  {safeFormatDate(delivery.delivery_date, 'EEEE, MMMM d, yyyy')}
                </p>
                {(delivery.delivery_time_start || delivery.delivery_time_end) && (
                  <p style={{ color: 'var(--text-slate-600)' }}>
                     {delivery.delivery_time_start && delivery.delivery_time_end
                      ? `${delivery.delivery_time_start} - ${delivery.delivery_time_end}`
                      : delivery.delivery_time_start
                        ? `After ${delivery.delivery_time_start}`
                        : `Before ${delivery.delivery_time_end}`
                    }
                  </p>
                )}
              </div>
            </div>

            {delivery.patient_phone && (
              <div className="flex items-center gap-3 text-sm">
                <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: 'var(--bg-slate-100)' }}>
                  <Phone className="w-4 h-4" style={{ color: 'var(--text-slate-600)' }} />
                </div>
                <div>
                  <p className="font-medium" style={{ color: 'var(--text-slate-900)' }}>Patient Phone</p>
                  <span style={{ color: 'var(--text-slate-600)' }}>{formatPhoneNumber(delivery.patient_phone)}</span>
                </div>
              </div>
            )}

            {delivery.store_phone && (
              <div className="flex items-center gap-3 text-sm">
                <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: 'var(--bg-slate-100)' }}>
                  <Phone className="w-4 h-4" style={{ color: 'var(--text-slate-600)' }} />
                </div>
                <div>
                  <p className="font-medium" style={{ color: 'var(--text-slate-900)' }}>Store Phone</p>
                  <span style={{ color: 'var(--text-slate-600)' }}>{formatPhoneNumber(delivery.store_phone)}</span>
                </div>
              </div>
            )}

            {delivery.driver_name && (
              <div className="flex items-center gap-3 text-sm">
                <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: 'var(--bg-slate-100)' }}>
                  <User className="w-4 h-4" style={{ color: 'var(--text-slate-600)' }} />
                </div>
                <div>
                  <p className="font-medium" style={{ color: 'var(--text-slate-900)' }}>Driver</p>
                  <p style={{ color: 'var(--text-slate-600)' }}>{delivery.driver_name}</p>
                </div>
              </div>
            )}

            {delivery.estimated_duration && (
              <div className="flex items-center gap-3 text-sm">
                <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: 'var(--bg-slate-100)' }}>
                  <Clock className="w-4 h-4" style={{ color: 'var(--text-slate-600)' }} />
                </div>
                <div>
                  <p className="font-medium" style={{ color: 'var(--text-slate-900)' }}>Estimated Duration</p>
                  <p style={{ color: 'var(--text-slate-600)' }}>{delivery.estimated_duration} minutes</p>
                </div>
              </div>
            )}

            {delivery.actual_delivery_time && (
              <div className="flex items-center gap-3 text-sm">
                <div className="w-8 h-8 bg-emerald-100 rounded-lg flex items-center justify-center" style={{ background: 'var(--bg-slate-100)' }}>
                  <CheckCircle className="w-4 h-4 text-emerald-600" />
                </div>
                <div>
                  <p className="font-medium" style={{ color: 'var(--text-slate-900)' }}>Delivered At</p>
                  <p style={{ color: 'var(--text-slate-600)' }}>
                    {safeFormatDate(delivery.actual_delivery_time, 'MMM d, yyyy h:mm a')}
                  </p>
                </div>
              </div>
            )}

            {/* NEW: COD Information Display */}
            {hasCOD && (
              <div className={`flex items-start gap-3 text-sm p-3 rounded-lg border ${
                isCODComplete ? 'bg-emerald-50 border-emerald-200' : 'bg-amber-50 border-amber-200'
              }`}>
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center mt-0.5 ${
                  isCODComplete ? 'bg-emerald-100' : 'bg-amber-100'
                }`}>
                  <Package className={`w-4 h-4 ${
                    isCODComplete ? 'text-emerald-600' : 'text-amber-600'
                  }`} />
                </div>
                <div className="flex-1">
                  <p className="font-medium mb-2" style={{ color: 'var(--text-slate-900)' }}>COD Payment</p>
                  
                  {/* Required Amount */}
                  <div className="flex items-center justify-between mb-2">
                    <span style={{ color: 'var(--text-slate-600)' }}>Required:</span>
                    <span className="font-semibold" style={{ color: 'var(--text-slate-900)' }}>
                      ${codTotalRequired.toFixed(2)}
                    </span>
                  </div>

                  {/* Collected Payments Breakdown */}
                  {codPayments.length > 0 && (
                    <div className="space-y-1 mb-2">
                      <span className="text-xs font-medium" style={{ color: 'var(--text-slate-500)' }}>Collected:</span>
                      {codPayments.map((payment, index) => (
                        <div key={index} className="flex items-center justify-between text-xs pl-2">
                          <span style={{ color: 'var(--text-slate-600)' }}>{payment.type}:</span>
                          <span className="font-medium" style={{ color: 'var(--text-slate-700)' }}>
                            ${parseFloat(payment.amount).toFixed(2)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Total Collected */}
                  {codPayments.length > 0 && (
                    <div className={`flex items-center justify-between pt-2 border-t ${
                      isCODComplete ? 'border-emerald-200' : 'border-amber-200'
                    }`}>
                      <span className="font-medium" style={{ color: 'var(--text-slate-700)' }}>Total Collected:</span>
                      <span className={`font-bold ${
                        isCODComplete ? 'text-emerald-700' : 'text-amber-700'
                      }`}>
                        ${codTotalCollected.toFixed(2)}
                      </span>
                    </div>
                  )}

                  {/* Status Badge */}
                  {codPayments.length === 0 && (
                    <div className="text-xs text-amber-600 mt-1">
                      Awaiting collection
                    </div>
                  )}
                  {codPayments.length > 0 && !isCODComplete && (
                    <div className="text-xs text-amber-600 mt-1">
                      Partial payment (${(codTotalRequired - codTotalCollected).toFixed(2)} remaining)
                    </div>
                  )}
                  {isCODComplete && (
                    <div className="text-xs text-emerald-600 mt-1 flex items-center gap-1">
                      <CheckCircle className="w-3 h-3" />
                      Payment complete
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {(delivery.delivery_instructions || delivery.delivery_notes) && (
            <div className="pt-3 border-t space-y-3" style={{ borderColor: 'var(--border-slate-200)' }}>
              {delivery.delivery_instructions && (
                <div className="flex items-start gap-3 text-sm">
                  <div className="w-8 h-8 rounded-lg flex items-center justify-center mt-0.5" style={{ background: 'var(--bg-slate-100)' }}>
                    <AlertCircle className="w-4 h-4" style={{ color: 'var(--text-slate-600)' }} />
                  </div>
                  <div>
                    <p className="font-medium mb-1" style={{ color: 'var(--text-slate-900)' }}>Delivery Instructions</p>
                    <p className="leading-relaxed whitespace-pre-wrap" style={{ color: 'var(--text-slate-600)' }}>{delivery.delivery_instructions.replace(/ - /g, '\n')}</p>
                  </div>
                </div>
              )}

              {delivery.delivery_notes && (
                <div className="flex items-start gap-3 text-sm">
                  <div className="w-8 h-8 rounded-lg flex items-center justify-center mt-0.5" style={{ background: 'var(--bg-slate-100)' }}>
                    <FileText className="w-4 h-4" style={{ color: 'var(--text-slate-600)' }} />
                  </div>
                  <div>
                    <p className="font-medium mb-1" style={{ color: 'var(--text-slate-900)' }}>Driver Notes</p>
                    <p className="leading-relaxed whitespace-pre-wrap" style={{ color: 'var(--text-slate-600)' }}>{delivery.delivery_notes.replace(/ - /g, '\n')}</p>
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Patient Info Card */}
      {patient && (
        <Card className="border shadow-sm" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <User className="w-5 h-5 text-blue-600" />
              <span style={{ color: 'var(--text-slate-900)' }}>Patient Information</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <p className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>{patient.full_name}</p>
              <p className="text-sm" style={{ color: 'var(--text-slate-600)' }}>{patient.address}</p>
              {patient.phone && (
                <p className="text-sm mt-1" style={{ color: 'var(--text-slate-600)' }}>
                  📞 {formatPhoneNumber(patient.phone)}
                </p>
              )}
            </div>
            {patient.notes && (
              <div className="pt-3 border-t" style={{ borderColor: 'var(--border-slate-200)' }}>
                <p className="text-xs font-semibold mb-1" style={{ color: 'var(--text-slate-500)' }}>Notes:</p>
                <p className="text-xs" style={{ color: 'var(--text-slate-700)' }}>{patient.notes}</p>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}