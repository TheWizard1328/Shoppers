import React, { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { CheckCircle, XCircle, Package, Clock, Home, MapPin, Camera } from 'lucide-react';
import { format } from 'date-fns';
import confetti from 'canvas-confetti';

export default function EndOfDayStatsDialog({ 
  isOpen, 
  onClose, 
  deliveries = [],
  driver,
  deliveryDate 
}) {
  const [stats, setStats] = useState(null);

  useEffect(() => {
    if (!isOpen || !deliveries || deliveries.length === 0) return;

    // Calculate stats
    const finishedStatuses = ['completed', 'failed', 'cancelled'];
    
    // Helper to check if delivery is a return
    const isReturn = (delivery) => {
      if (!delivery) return false;
      const notes = delivery.delivery_notes || '';
      const patientName = delivery.patient_name || '';
      return notes.toLowerCase().includes('(rtn)') ||
        patientName.toLowerCase().includes('(rtn)') ||
        /\breturn\b/i.test(notes) ||
        /\breturn\b/i.test(patientName);
    };

    // CRITICAL: Only count patient deliveries (not pickups)
    const patientDeliveries = deliveries.filter(d => d && d.patient_id);
    
    const completed = patientDeliveries.filter(d => d.status === 'completed' && !isReturn(d)).length;
    const failed = patientDeliveries.filter(d => d.status === 'failed' && !isReturn(d)).length;
    const cancelled = patientDeliveries.filter(d => d.status === 'cancelled').length;
    const returned = patientDeliveries.filter(isReturn).length;
    
    const successfulDeliveries = patientDeliveries.filter(d => d.status === 'completed' && !isReturn(d));
    const deliveriesWithPOD = successfulDeliveries.filter(d => {
      const hasSignature = !!d.signature_image_url;
      const hasPhoto = Array.isArray(d.proof_photo_urls) && d.proof_photo_urls.length > 0;
      return hasSignature || hasPhoto;
    }).length;

    // Calculate total distance (sum of all travel_dist)
    const totalDistance = patientDeliveries.reduce((sum, d) => {
      return sum + (d.travel_dist || 0);
    }, 0);
    
    // Calculate time on duty (first to last delivery)
    const finishedDeliveries = patientDeliveries.filter(d => 
      d && finishedStatuses.includes(d.status) && d.actual_delivery_time
    ).sort((a, b) => 
      new Date(a.actual_delivery_time) - new Date(b.actual_delivery_time)
    );
    
    let timeOnDuty = null;
    if (finishedDeliveries.length > 1) {
      const firstTime = new Date(finishedDeliveries[0].actual_delivery_time);
      const lastTime = new Date(finishedDeliveries[finishedDeliveries.length - 1].actual_delivery_time);
      const diffMs = lastTime - firstTime;
      const hours = Math.floor(diffMs / 3600000);
      const minutes = Math.floor((diffMs % 3600000) / 60000);
      timeOnDuty = `${hours}h ${minutes}m`;
    }

    setStats({
      total: patientDeliveries.length,
      completed,
      failed,
      cancelled,
      returned,
      deliveriesWithPOD,
      successfulDeliveries: successfulDeliveries.length,
      totalDistance: totalDistance.toFixed(2),
      timeOnDuty
    });

    // Trigger confetti on mount
    confetti({
      particleCount: 100,
      spread: 70,
      origin: { y: 0.6 }
    });
  }, [isOpen, deliveries]);

  if (!stats) return null;

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-md z-[10030] border" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)' }}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-emerald-600">
            <CheckCircle className="w-6 h-6" />
            <span style={{ color: 'var(--text-slate-900)' }}>
              Route Complete!
            </span>
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

            {stats.timeOnDuty && (
              <div className="p-3 rounded-lg border text-center" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                <Clock className="w-5 h-5 mx-auto mb-1 text-slate-600" />
                <div className="text-lg font-bold" style={{ color: 'var(--text-slate-900)' }}>{stats.timeOnDuty}</div>
                <div className="text-xs" style={{ color: 'var(--text-slate-600)' }}>Time on Duty</div>
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
              className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white"
              onClick={onClose}
            >
              <Home className="w-4 h-4 mr-2" />
              Close
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}