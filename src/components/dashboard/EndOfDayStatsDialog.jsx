import React, { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { CheckCircle, XCircle, Package, Clock, Home, MapPin, Camera, DollarSign } from 'lucide-react';
import { format } from 'date-fns';
import confetti from 'canvas-confetti';

export default function EndOfDayStatsDialog({ 
  isOpen, 
  onClose, 
  deliveries = [],
  driver,
  deliveryDate,
  isProcessing = false,
  performanceStats,
  localStats,
}) {
  const [stats, setStats] = useState(null);

  useEffect(() => {
    if (!isOpen) return;

    // POD count still needs to be derived from deliveries
    const patientDeliveries = (deliveries || []).filter(d => d && d.patient_id);
    const successfulDeliveries = patientDeliveries.filter(d => d.status === 'completed');
    const deliveriesWithPOD = successfulDeliveries.filter(d => {
      return !!d.signature_image_url || (Array.isArray(d.proof_photo_urls) && d.proof_photo_urls.length > 0);
    }).length;

    // Use dashboard card values directly
    const total = localStats?.total ?? patientDeliveries.length;
    const completed = localStats?.completed ?? successfulDeliveries.length;
    const failed = localStats?.failed ?? patientDeliveries.filter(d => d.status === 'failed').length;
    const returned = localStats?.returned ?? 0;
    const totalKm = performanceStats?.totalKm ?? patientDeliveries.reduce((sum, d) => sum + (d.travel_dist || 0), 0);
    const totalPay = performanceStats?.totalPay ?? null;
    const timeOnDuty = performanceStats?.totalTimeOnDuty ?? null;

    // Hourly rate from dashboard pay / duty time
    let hourlyRate = null;
    if (totalPay && timeOnDuty && timeOnDuty !== '00:00') {
      const [hh, mm] = timeOnDuty.split(':').map(Number);
      const totalHours = hh + mm / 60;
      if (totalHours > 0) hourlyRate = (totalPay / totalHours).toFixed(2);
    }

    setStats({
      total,
      completed,
      failed,
      returned,
      deliveriesWithPOD,
      successfulDeliveries: successfulDeliveries.length,
      totalDistance: Number(totalKm).toFixed(2),
      totalPay: totalPay ? totalPay.toFixed(2) : null,
      timeOnDuty,
      hourlyRate,
    });

    confetti({
      particleCount: 100,
      spread: 70,
      origin: { y: 0.6 }
    });
  }, [isOpen, performanceStats, localStats]);

  if (!stats && !isProcessing) return null;
  if (!stats) return (
    <Dialog open={isOpen} onOpenChange={() => {}}>
      <DialogContent className="max-w-md z-[10030] border" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)' }}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CheckCircle className="w-6 h-6 text-emerald-600" />
            <span style={{ color: 'var(--text-slate-900)' }}>Route Complete!</span>
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col items-center justify-center py-10 gap-3">
          <div className="w-8 h-8 border-4 border-emerald-200 border-t-emerald-600 rounded-full animate-spin" />
          <p className="text-sm" style={{ color: 'var(--text-slate-600)' }}>Finalizing your route stats...</p>
        </div>
      </DialogContent>
    </Dialog>
  );

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-md z-[10030] border" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)' }}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-emerald-600">
            <CheckCircle className="w-6 h-6" />
            <span style={{ color: 'var(--text-slate-900)' }}>Route Complete!</span>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Driver & Date */}
          <div className="text-center pb-3 border-b" style={{ borderColor: 'var(--border-slate-200)' }}>
            <p className="text-lg font-semibold" style={{ color: 'var(--text-slate-900)' }}>
              {driver?.user_name || driver?.full_name || 'Driver'}
            </p>
            <p className="text-sm" style={{ color: 'var(--text-slate-600)' }}>
              {deliveryDate ? format(new Date(deliveryDate + 'T00:00:00'), 'EEEE, MMMM d, yyyy') : ''}
            </p>
          </div>

          {/* Stats Grid */}
          <div className="grid grid-cols-2 gap-3">
            <div className="p-3 rounded-lg border text-center" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
              <Package className="w-5 h-5 mx-auto mb-1 text-slate-600" />
              <div className="text-2xl font-bold" style={{ color: 'var(--text-slate-900)' }}>{stats.total}</div>
              <div className="text-xs" style={{ color: 'var(--text-slate-600)' }}>Total Stops</div>
            </div>

            {stats.timeOnDuty && (
              <div className="p-3 rounded-lg border text-center" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                <Clock className="w-5 h-5 mx-auto mb-1 text-slate-600" />
                <div className="text-lg font-bold" style={{ color: 'var(--text-slate-900)' }}>{stats.timeOnDuty}</div>
                <div className="text-xs" style={{ color: 'var(--text-slate-600)' }}>Time on Duty</div>
              </div>
            )}

            <div className="p-3 rounded-lg border text-center" style={{ background: 'var(--bg-emerald-50)', borderColor: 'var(--border-emerald-200)' }}>
              <CheckCircle className="w-5 h-5 mx-auto mb-1 text-emerald-600" />
              <div className="text-2xl font-bold text-emerald-700">{stats.completed}</div>
              <div className="text-xs text-emerald-600">Completed</div>
            </div>

            {(stats.failed > 0 || stats.returned > 0) && (
              <div className="p-3 rounded-lg border text-center" style={{ background: 'var(--bg-red-50)', borderColor: 'var(--border-red-200)' }}>
                <XCircle className="w-5 h-5 mx-auto mb-1 text-red-600" />
                <div className="text-2xl font-bold text-red-700">{stats.failed} / {stats.returned}</div>
                <div className="text-xs text-red-600">Failed / Returns</div>
              </div>
            )}

            <div className="p-3 rounded-lg border text-center" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
              <MapPin className="w-5 h-5 mx-auto mb-1 text-slate-600" />
              <div className="text-lg font-bold" style={{ color: 'var(--text-slate-900)' }}>{stats.totalDistance} km</div>
              <div className="text-xs" style={{ color: 'var(--text-slate-600)' }}>Total Distance</div>
            </div>

            <div className="p-3 rounded-lg border text-center" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
              <Camera className="w-5 h-5 mx-auto mb-1 text-slate-600" />
              <div className="text-lg font-bold" style={{ color: 'var(--text-slate-900)' }}>{stats.deliveriesWithPOD} / {stats.successfulDeliveries}</div>
              <div className="text-xs" style={{ color: 'var(--text-slate-600)' }}>Proof of Delivery</div>
            </div>

            {stats.totalPay !== null && (
              <div className="p-3 rounded-lg border text-center" style={{ background: 'var(--bg-emerald-50)', borderColor: 'var(--border-emerald-200)' }}>
                <DollarSign className="w-5 h-5 mx-auto mb-1 text-emerald-600" />
                <div className="text-lg font-bold text-emerald-700">${stats.totalPay}</div>
                <div className="text-xs text-emerald-600">Total Pay</div>
              </div>
            )}

            {stats.hourlyRate !== null && (
              <div className="p-3 rounded-lg border text-center" style={{ background: 'var(--bg-purple-50)', borderColor: 'var(--border-purple-200)' }}>
                <DollarSign className="w-5 h-5 mx-auto mb-1 text-purple-600" />
                <div className="text-lg font-bold text-purple-700">${stats.hourlyRate}/hr</div>
                <div className="text-xs text-purple-600">Hourly Rate</div>
              </div>
            )}
          </div>

          {/* Completion Message */}
          <div className="text-center py-3 px-4 rounded-lg border" style={{ background: 'var(--bg-emerald-50)', borderColor: 'var(--border-emerald-200)' }}>
            <p className="text-sm font-medium text-emerald-700">
              🎉 Great work today! All deliveries have been completed.
            </p>
          </div>

          {/* Action Buttons */}
          <div className="flex gap-3 pt-2">
            <Button
              className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-60"
              onClick={onClose}
              disabled={isProcessing}
            >
              {isProcessing ? (
                <>
                  <div className="w-4 h-4 mr-2 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Processing...
                </>
              ) : (
                <>
                  <Home className="w-4 h-4 mr-2" />
                  Close
                </>
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}