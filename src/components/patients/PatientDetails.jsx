import React, { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { formatPhoneNumber } from "../utils/phoneFormatter";
import {
  BarChart3,
  Package,
  Calendar,
  CheckCircle,
  Clock,
  ExternalLink,
  XCircle,
  FileText,
  Users } from
"lucide-react";
import { format } from "date-fns";

const RecentDeliveries = ({ deliveries, patient }) => {

  // Filter deliveries for this patient and sort by date (most recent first)
  const patientDeliveries = deliveries
    .filter((d) => d.patient_id === patient.id)
    .sort((a, b) => new Date(b.delivery_date) - new Date(a.delivery_date))
    .slice(0, 5);

  const getStatusColor = (status) => {
    switch (status) {
      case 'completed':
        return { bg: 'bg-emerald-50', border: 'border-emerald-200', badge: 'bg-emerald-100' };
      case 'failed':
        return { bg: 'bg-red-50', border: 'border-red-200', badge: 'bg-red-100' };
      case 'pending':
        return { bg: 'bg-amber-50', border: 'border-amber-200', badge: 'bg-amber-100' };
      case 'in_transit':
        return { bg: 'bg-blue-50', border: 'border-blue-200', badge: 'bg-blue-100' };
      default:
        return { bg: 'bg-slate-50', border: 'border-slate-200', badge: 'bg-slate-100' };
    }
  };

  return (
    <Card className="shadow-sm" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
      <CardHeader className="px-4 py-2">
        <CardTitle className="flex items-center gap-2" style={{ color: 'var(--text-slate-900)' }}>
          <Package className="w-5 h-5 text-blue-600" />
          Recent Deliveries
        </CardTitle>
      </CardHeader>
      <CardContent>
        {patientDeliveries.length === 0 ? (
          <p className="text-sm text-center py-4" style={{ color: 'var(--text-slate-500)' }}>
            No deliveries found
          </p>
        ) : (
          <div className="space-y-2">
            {patientDeliveries.map((delivery) => {
              const colors = getStatusColor(delivery.status);
              return (
                <div
                  key={delivery.id}
                  className={`p-3 rounded-lg border ${colors.bg} ${colors.border}`}>
                  <div className="grid grid-cols-2 gap-3 mb-2">
                    <div className="text-xs space-y-1">
                      <div className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>
                        {format(new Date(delivery.delivery_date + 'T12:00:00'), 'EEE, MMM d')}
                      </div>
                      {delivery.tracking_number && (
                        <div style={{ color: 'var(--text-slate-600)' }}>
                          <span className="font-medium">TR#:</span> {delivery.tracking_number}
                        </div>
                      )}
                      {delivery.actual_delivery_time && (
                        <div style={{ color: 'var(--text-slate-600)' }}>
                          <span className="font-medium">Completed:</span> {format(new Date(delivery.actual_delivery_time), 'HH:mm')}
                        </div>
                      )}
                    </div>
                    <div className="flex flex-col gap-1 items-end">
                      <Badge className={`text-xs ${colors.badge}`} style={{ color: 'var(--text-slate-900)' }}>
                        {delivery.status === 'in_transit' ? 'In Transit' : 
                         delivery.status === 'completed' ? 'Completed' :
                         delivery.status === 'pending' ? 'Pending' :
                         delivery.status === 'failed' ? 'Failed' : 
                         delivery.status}
                      </Badge>
                      {delivery.driver_name && (
                        <Badge variant="outline" className="text-xs" style={{ color: 'var(--text-slate-700)' }}>
                          {delivery.driver_name}
                        </Badge>
                      )}
                      {delivery.cod_payments && delivery.cod_payments.length > 0 && (
                        <Badge variant="secondary" className="text-xs">
                          {delivery.cod_payments[0].type}: ${delivery.cod_payments.reduce((sum, p) => sum + p.amount, 0).toFixed(2)}
                        </Badge>
                      )}
                    </div>
                  </div>
                  {delivery.delivery_notes && (
                    <div className="text-xs pt-2 border-t" style={{ color: 'var(--text-slate-600)', borderColor: 'var(--border-slate-300)' }}>
                      <span className="font-medium">Notes:</span> {delivery.delivery_notes}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );

};

export default function PatientDetails({ patient, deliveries, deliveryStats }) {
  if (!patient) {
    return (
      <div className="text-center py-10" style={{ color: 'var(--text-slate-500)' }}>
        <p className="text-lg mb-2">Select a patient to view details</p>
        <p className="text-sm">Click on any patient card on the left to see analytics and recent delivery history.</p>
      </div>);

  }

  // Day abbreviation mapping for consistent display
  const dayAbbreviations = {
    'Monday': 'Mon',
    'Tuesday': 'Tue',
    'Wednesday': 'Wed',
    'Thursday': 'Thu',
    'Friday': 'Fri',
    'Saturday': 'Sat',
    'Sunday': 'Sun'
  };

  return (
    <div className="space-y-6 sticky top-6">
      {/* Delivery Statistics */}
      {deliveryStats &&
      <Card className="shadow-sm" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2" style={{ color: 'var(--text-slate-900)' }}>
              <BarChart3 className="w-5 h-5 text-blue-600" />
              Delivery Analytics
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 space-y-2">
            <div className="grid grid-cols-2 gap-4">
              <div className="text-center p-3 rounded-lg" style={{ background: 'var(--bg-slate-50)' }}>
                <p className="text-2xl font-bold" style={{ color: 'var(--text-slate-900)' }}>{deliveryStats.totalDeliveries}</p>
                <p className="text-sm" style={{ color: 'var(--text-slate-600)' }}>Total</p>
              </div>
              <div className="text-center p-3 bg-emerald-50 rounded-lg">
                <p className="text-2xl font-bold text-emerald-700">
                  {deliveryStats.mostCommonDay ? dayAbbreviations[deliveryStats.mostCommonDay] || deliveryStats.mostCommonDay.substring(0, 3) : 'N/A'}
                </p>
                <p className="text-sm" style={{ color: 'var(--text-slate-600)' }}>Most Common Day</p>
              </div>
            </div>

            {deliveryStats.lastDeliveryDate &&
          <div className="flex items-center gap-3 text-sm p-3 rounded-lg" style={{ background: 'var(--bg-slate-50)' }}>
                <Calendar className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--text-slate-500)' }} />
                <div>
                  <p className="font-medium" style={{ color: 'var(--text-slate-900)' }}>Last Delivery</p>
                  <p style={{ color: 'var(--text-slate-600)' }}>
                    {format(new Date(deliveryStats.lastDeliveryDate + 'T12:00:00'), 'EEE, MMM d, yyyy')}
                  </p>
                </div>
              </div>
          }

            {deliveryStats.dayFrequency && Object.keys(deliveryStats.dayFrequency).length > 0 &&
          <div>
                <p className="font-medium mb-3" style={{ color: 'var(--text-slate-900)' }}>Delivery Pattern</p>
                <div className="space-y-2">
                  {Object.entries(deliveryStats.dayFrequency).
              sort(([, a], [, b]) => b - a).
              map(([day, count]) =>
              <div key={day} className="flex justify-between items-center text-sm">
                        <span className="min-w-[40px]" style={{ color: 'var(--text-slate-600)' }}>{dayAbbreviations[day] || day.substring(0, 3)}</span>
                        <div className="flex items-center gap-2 flex-1">
                          <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ background: 'var(--bg-slate-200)' }}>
                            <div
                      className="h-full bg-emerald-500 rounded-full transition-all duration-300"
                      style={{ width: `${count / deliveryStats.totalDeliveries * 100}%` }} />

                          </div>
                          <Badge variant="outline" className="text-xs min-w-[2.5rem] justify-center">
                            {count}
                          </Badge>
                        </div>
                      </div>
              )}
                </div>
              </div>
          }
          </CardContent>
        </Card>
      }

      {/* Recent Deliveries */}
      <RecentDeliveries deliveries={deliveries} patient={patient} />
    </div>);

}