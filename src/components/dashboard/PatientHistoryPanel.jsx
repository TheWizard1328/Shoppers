import React, { useState, useEffect } from "react";
import { X, Package, BarChart3, Calendar, ChevronDown, Eye, Pencil } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { Badge } from "@/components/ui/badge";
import { format } from "date-fns";
import { base44 } from "@/api/base44Client";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { userHasRole } from "@/components/utils/userRoles";

const dayAbbreviations = {
  'Monday': 'Mon', 'Tuesday': 'Tue', 'Wednesday': 'Wed',
  'Thursday': 'Thu', 'Friday': 'Fri', 'Saturday': 'Sat', 'Sunday': 'Sun'
};

const getStatusStyle = (status) => {
  switch (status) {
    case 'completed': return { color: '#15803d', background: 'rgba(22,163,74,0.12)', border: '1px solid rgba(22,163,74,0.25)' };
    case 'failed': return { color: '#b91c1c', background: 'rgba(220,38,38,0.12)', border: '1px solid rgba(220,38,38,0.25)' };
    case 'pending': return { color: '#b45309', background: 'rgba(217,119,6,0.12)', border: '1px solid rgba(217,119,6,0.25)' };
    case 'in_transit': return { color: '#1d4ed8', background: 'rgba(37,99,235,0.12)', border: '1px solid rgba(37,99,235,0.25)' };
    default: return { color: 'var(--text-slate-700)', background: 'var(--bg-slate-100)', border: '1px solid var(--border-slate-200)' };
  }
};

export default function PatientHistoryPanel({ patient, deliveries, currentUser, onClose, onEditDelivery }) {
  const [analyticsCollapsed, setAnalyticsCollapsed] = useState(false);
  const [codOnly, setCodOnly] = useState(false);
  const [deliveryStats, setDeliveryStats] = useState(null);

  useEffect(() => {
    if (!patient) return;

    const patientDeliveries = (deliveries || []).filter(
      (d) => d && d.patient_id === patient.id && d.status === 'completed'
    );

    if (patientDeliveries.length === 0) {
      setDeliveryStats({ totalDeliveries: 0, mostCommonDay: null, lastDeliveryDate: null, dayFrequency: {} });
      return;
    }

    const dayFrequency = {};
    let lastDate = null;

    patientDeliveries.forEach((d) => {
      const dateObj = new Date(d.delivery_date + 'T12:00:00');
      const dayName = dateObj.toLocaleDateString('en-US', { weekday: 'long' });
      dayFrequency[dayName] = (dayFrequency[dayName] || 0) + 1;
      if (!lastDate || d.delivery_date > lastDate) lastDate = d.delivery_date;
    });

    const mostCommonDay = Object.entries(dayFrequency).sort(([, a], [, b]) => b - a)[0]?.[0] || null;

    setDeliveryStats({
      totalDeliveries: patientDeliveries.length,
      mostCommonDay,
      lastDeliveryDate: lastDate,
      dayFrequency
    });
  }, [patient, deliveries]);

  const patientDeliveries = (deliveries || [])
    .filter((d) => d && d.patient_id === patient?.id)
    .filter((d) => !codOnly || Number(d.cod_total_amount_required || 0) > 0)
    .sort((a, b) => new Date(b.delivery_date) - new Date(a.delivery_date))
    .slice(0, 30);

  return (
    <AnimatePresence>
      {patient && (
        <>
          {/* Backdrop */}
          <motion.div
            key="backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[9990]"
            style={{ background: 'rgba(0,0,0,0.3)' }}
            onClick={onClose}
          />

          {/* Slide-out Panel */}
          <motion.div
            key="panel"
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            className="fixed top-0 right-0 h-full z-[9991] flex flex-col shadow-2xl"
            style={{
              width: 'min(400px, 100vw)',
              background: 'var(--bg-white)',
              borderLeft: '1px solid var(--border-slate-200)'
            }}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b flex-shrink-0" style={{ borderColor: 'var(--border-slate-200)', background: 'var(--bg-slate-50)' }}>
              <div className="min-w-0">
                <h2 className="font-semibold text-base truncate" style={{ color: 'var(--text-slate-900)' }}>
                  {patient.full_name}
                </h2>
                <p className="text-xs truncate" style={{ color: 'var(--text-slate-500)' }}>
                  {patient.address}
                </p>
              </div>
              <button
                onClick={onClose}
                className="ml-2 p-1.5 rounded-lg hover:bg-slate-200 transition-colors flex-shrink-0"
                style={{ color: 'var(--text-slate-600)' }}
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Scrollable content */}
            <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">

              {/* Analytics Card */}
              {deliveryStats && (
                <div className="rounded-xl border shadow-sm" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
                  <div
                    className="flex items-center justify-between px-4 py-3 cursor-pointer select-none"
                    onClick={() => setAnalyticsCollapsed(v => !v)}
                  >
                    <span className="flex items-center gap-2 font-semibold text-sm" style={{ color: 'var(--text-slate-900)' }}>
                      <BarChart3 className="w-4 h-4 text-blue-600" />
                      Delivery Analytics
                    </span>
                    <ChevronDown
                      className="w-4 h-4 transition-transform duration-200"
                      style={{ color: 'var(--text-slate-400)', transform: analyticsCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}
                    />
                  </div>

                  {!analyticsCollapsed && (
                    <div className="px-3 pb-3 space-y-2">
                      <div className="grid grid-cols-2 gap-2">
                        <div className="text-center p-3 rounded-lg" style={{ background: 'var(--bg-slate-50)' }}>
                          <p className="text-2xl font-bold" style={{ color: 'var(--text-slate-900)' }}>{deliveryStats.totalDeliveries}</p>
                          <p className="text-sm" style={{ color: 'var(--text-slate-600)' }}>Total</p>
                        </div>
                        <div className="text-center p-3 rounded-lg" style={{ background: 'rgba(16,185,129,0.1)' }}>
                          <p className="text-2xl font-bold" style={{ color: '#059669' }}>
                            {deliveryStats.mostCommonDay ? dayAbbreviations[deliveryStats.mostCommonDay] || deliveryStats.mostCommonDay.substring(0, 3) : 'N/A'}
                          </p>
                          <p className="text-sm" style={{ color: 'var(--text-slate-600)' }}>Most Common Day</p>
                        </div>
                      </div>

                      {deliveryStats.lastDeliveryDate && (
                        <div className="flex items-center gap-3 text-sm p-3 rounded-lg" style={{ background: 'var(--bg-slate-50)' }}>
                          <Calendar className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--text-slate-500)' }} />
                          <div>
                            <p className="font-medium" style={{ color: 'var(--text-slate-900)' }}>Last Delivery</p>
                            <p style={{ color: 'var(--text-slate-600)' }}>
                              {format(new Date(deliveryStats.lastDeliveryDate + 'T12:00:00'), 'EEE, MMM d, yyyy')}
                            </p>
                          </div>
                        </div>
                      )}

                      {deliveryStats.dayFrequency && Object.keys(deliveryStats.dayFrequency).length > 0 && (
                        <div>
                          <p className="font-medium mb-2 text-sm" style={{ color: 'var(--text-slate-900)' }}>Delivery Pattern</p>
                          <div className="space-y-1">
                            {Object.entries(deliveryStats.dayFrequency)
                              .sort(([, a], [, b]) => b - a)
                              .map(([day, count]) => (
                                <div key={day} className="flex justify-between items-center text-sm">
                                  <span className="min-w-[36px]" style={{ color: 'var(--text-slate-600)' }}>
                                    {dayAbbreviations[day] || day.substring(0, 3)}
                                  </span>
                                  <div className="flex items-center gap-2 flex-1">
                                    <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ background: 'var(--bg-slate-200)' }}>
                                      <div
                                        className="h-full bg-emerald-500 rounded-full transition-all duration-300"
                                        style={{ width: `${count / deliveryStats.totalDeliveries * 100}%` }}
                                      />
                                    </div>
                                    <Badge variant="outline" className="text-xs min-w-[2.5rem] justify-center">{count}</Badge>
                                  </div>
                                </div>
                              ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Recent Deliveries */}
              <div className="rounded-xl border shadow-sm" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
                <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: 'var(--border-slate-100)' }}>
                  <span className="flex items-center gap-2 font-semibold text-sm" style={{ color: 'var(--text-slate-900)' }}>
                    <Package className="w-4 h-4 text-blue-600" />
                    Recent Deliveries
                  </span>
                  <label className="flex items-center gap-1.5 text-xs font-normal cursor-pointer select-none" style={{ color: 'var(--text-slate-600)' }}>
                    <input
                      type="checkbox"
                      checked={codOnly}
                      onChange={(e) => setCodOnly(e.target.checked)}
                      className="rounded"
                    />
                    COD only
                  </label>
                </div>

                <div className="p-3">
                  {patientDeliveries.length === 0 ? (
                    <p className="text-sm text-center py-4" style={{ color: 'var(--text-slate-500)' }}>No deliveries found</p>
                  ) : (
                    <div className="space-y-2">
                      {patientDeliveries.map((delivery) => {
                        const statusStyle = getStatusStyle(delivery.status);
                        return (
                          <div
                            key={delivery.id}
                            className="p-3 rounded-lg border"
                            style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}
                          >
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
                                <Badge className="text-xs font-semibold" style={{ background: statusStyle.background, color: statusStyle.color, border: statusStyle.border }}>
                                  {delivery.status === 'in_transit' ? 'In Transit' :
                                   delivery.status === 'completed' ? 'Completed' :
                                   delivery.status === 'pending' ? 'Pending' :
                                   delivery.status === 'failed' ? 'Failed' : delivery.status}
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
                            <div className={`flex items-center justify-between ${delivery.delivery_notes ? 'pt-2 border-t' : ''}`} style={{ borderColor: 'var(--border-slate-300)' }}>
                              {delivery.delivery_notes && (
                                <div className="text-xs flex-1 mr-2" style={{ color: 'var(--text-slate-600)' }}>
                                  <span className="font-medium">Notes:</span> {delivery.delivery_notes}
                                </div>
                              )}
                              <div className="ml-auto flex items-center gap-2">
                                {userHasRole(currentUser, 'admin') && onEditDelivery && (
                                  <button
                                    onClick={() => onEditDelivery(delivery)}
                                    className="flex items-center gap-1 text-xs font-medium shrink-0"
                                    style={{ color: 'var(--text-slate-500)' }}
                                  >
                                    <Pencil className="w-3 h-3" />
                                    Edit
                                  </button>
                                )}
                                <Link
                                  to={createPageUrl(`Dashboard?date=${delivery.delivery_date}&driver=${delivery.driver_id || ''}`)}
                                  onClick={onClose}
                                  className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 font-medium shrink-0"
                                >
                                  <Eye className="w-3 h-3" />
                                  View
                                </Link>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}