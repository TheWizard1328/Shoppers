import React, { useState, useEffect, useRef } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { CheckCircle, XCircle, Package, Clock, Home, MapPin, Camera, DollarSign, Car, Bike } from 'lucide-react';
import { format } from 'date-fns';
import confetti from 'canvas-confetti';

const pickRandom = (arr) => arr[Math.floor(Math.random() * arr.length)];

const getEncouragementMessage = ({ routeComplete, completed, total, timeOnDuty, hourlyRate }) => {
  // Route fully done
  if (routeComplete) {
    return { emoji: '🎉', text: 'Great work today! All deliveries have been completed.', color: 'emerald' };
  }

  const remaining = total - completed;
  const routeStarted = completed > 0;

  // Route not yet started (all pending)
  if (!routeStarted) {
    const messages = [
      { emoji: '🚀', text: `${total} stops ready to roll — let's have a great day out there!` },
      { emoji: '💪', text: `${total} deliveries waiting on you. You've got this — let's get moving!` },
      { emoji: '⭐', text: `A fresh route with ${total} stops ahead. Make it a great one!` },
      { emoji: '🗺️', text: `Ready to hit the road? ${total} stops are counting on you today!` },
    ];
    return { ...pickRandom(messages), color: 'blue' };
  }

  // Route in progress — build a context-aware message
  const timeStr = timeOnDuty && timeOnDuty !== '00:00' ? ` in ${timeOnDuty}` : '';
  const payStr = hourlyRate ? ` at $${hourlyRate}/hr` : '';

  const messages = [
    { emoji: '🚚', text: `${completed} of ${total} done${timeStr}${payStr} — keep the momentum going, ${remaining} more to go!` },
    { emoji: '💨', text: `Halfway there! ${completed} stops crushed${timeStr}${payStr}. ${remaining} left — finish strong!` },
    { emoji: '🔥', text: `${completed} down, ${remaining} to go${timeStr}${payStr}. You're on fire — don't slow down now!` },
    { emoji: '⚡', text: `Great pace! ${completed} completed${timeStr}${payStr}. Just ${remaining} more stops standing between you and done!` },
    { emoji: '🏁', text: `${completed} of ${total} in the bag${timeStr}${payStr}. ${remaining} stops left — the finish line is in sight!` },
  ];
  return { ...pickRandom(messages), color: 'blue' };
};

export default function EndOfDayStatsDialog({ 
  isOpen, 
  onClose, 
  deliveries = [],
  allYearDeliveries = [],
  driver,
  deliveryDate,
  isProcessing = false,
  performanceStats,
  localStats,
  isRouteComplete = false,
}) {
  const [stats, setStats] = useState(null);
  const encouragementRef = useRef(null);
  const messageLockedRef = useRef(false);

  // Reset lock when dialog closes so next open gets a fresh message
  useEffect(() => {
    if (!isOpen) {
      messageLockedRef.current = false;
      encouragementRef.current = null;
    }
  }, [isOpen]);

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
    const pending = patientDeliveries.filter(d => d.status === 'pending' || d.status === 'in_transit' || d.status === 'en_route').length;
    // Sum travel_dist across ALL stops regardless of status/type — driving/cycling must add up to total
    const allStops = (deliveries || []).filter(d => d);
    const drivingKm = allStops.filter(d => !d.transport_mode || d.transport_mode === 'driving').reduce((sum, d) => sum + (d.travel_dist || 0), 0);
    const cyclingKm = allStops.filter(d => d.transport_mode === 'cycling').reduce((sum, d) => sum + (d.travel_dist || 0), 0);
    // Total is always the sum of breakdown values so they're guaranteed to match
    const totalKm = drivingKm + cyclingKm;
    const totalPay = performanceStats?.totalPay ?? null;
    // For incomplete routes, calculate time from first completed stop to NOW
    let timeOnDuty = performanceStats?.totalTimeOnDuty ?? null;
    // Route is complete when nothing is still pending/in-transit.
    // inTransit covers all non-terminal stops (pending, en_route) regardless of type (patient, ISP/ISD, returns).
    const routeActuallyComplete = isRouteComplete || (
      localStats?.total > 0 &&
      (localStats?.completed ?? 0) > 0 &&
      (localStats?.inTransit ?? 1) === 0
    );

    if (!routeActuallyComplete) {
      // Use current time as the end point
      const completedDeliveries = (deliveries || []).filter(d => d && d.actual_delivery_time && d.status === 'completed');
      if (completedDeliveries.length > 0) {
        const times = completedDeliveries.map(d => new Date(d.actual_delivery_time).getTime());
        const firstTime = Math.min(...times);
        const nowMs = Date.now();
        const diffMin = Math.max(0, Math.round((nowMs - firstTime) / 60000));
        const hh = String(Math.floor(diffMin / 60)).padStart(2, '0');
        const mm = String(diffMin % 60).padStart(2, '0');
        timeOnDuty = `${hh}:${mm}`;
      }
    }

    // Hourly rate from dashboard pay / duty time
    let hourlyRate = null;
    if (totalPay && timeOnDuty && timeOnDuty !== '00:00') {
      const [hh, mm] = timeOnDuty.split(':').map(Number);
      const totalHours = hh + mm / 60;
      if (totalHours > 0) hourlyRate = (totalPay / totalHours).toFixed(2);
    }

    const routeStarted = completed > 0;
    // Remaining estimated distance = sum of estimated_distance_km for incomplete stops
    const incompleteStops = (deliveries || []).filter(d => d && !['completed', 'failed', 'cancelled'].includes(d.status));
    const remainingEstKm = !routeActuallyComplete && incompleteStops.length > 0
      ? incompleteStops.reduce((sum, d) => sum + (d.estimated_distance_km || 0), 0)
      : null;
    // For a not-yet-started route, show total estimated distance
    const estimatedTotalKm = !routeStarted
      ? (deliveries || []).filter(d => d).reduce((sum, d) => sum + (d.estimated_distance_km || 0), 0)
      : null;

    // Compute best day of the year from allYearDeliveries
    const currentYear = new Date().getFullYear();
    const yearStr = String(currentYear);
    const driverIdToMatch = driver?.user_id || driver?.id || null;

    // Group all year deliveries by date → count patient stops & sum pay
    const dayMap = new Map();
    (allYearDeliveries || []).forEach(d => {
      if (!d || !d.delivery_date || !d.delivery_date.startsWith(yearStr)) return;
      if (!d.patient_id) return; // only patient deliveries count
      if (driverIdToMatch && d.driver_id !== driverIdToMatch) return;
      if (!dayMap.has(d.delivery_date)) dayMap.set(d.delivery_date, { stops: 0, pay: 0 });
      const entry = dayMap.get(d.delivery_date);
      entry.stops += 1;
    });

    let bestDayByStops = null;
    let bestDayByEarned = null;

    if (dayMap.size > 0) {
      let maxStops = 0;
      for (const [date, entry] of dayMap) {
        if (entry.stops > maxStops) { maxStops = entry.stops; bestDayByStops = { date, stops: entry.stops }; }
      }
    }

    const newStats = {
      total,
      completed,
      pending,
      failed,
      returned,
      deliveriesWithPOD,
      successfulDeliveries: successfulDeliveries.length,
      totalDistance: Number(totalKm).toFixed(2),
      estimatedDistance: estimatedTotalKm != null ? Number(estimatedTotalKm).toFixed(2) : null,
      remainingDistance: remainingEstKm != null ? Number(remainingEstKm).toFixed(2) : null,
      drivingDistance: Number(drivingKm).toFixed(2),
      cyclingDistance: Number(cyclingKm).toFixed(2),
      totalPay: totalPay ? totalPay.toFixed(2) : null,
      timeOnDuty,
      hourlyRate,
      routeComplete: routeActuallyComplete,
      routeStarted,
      bestDayByStops,
    };
    // Pick a random message only once per open session
    if (!messageLockedRef.current) {
      encouragementRef.current = getEncouragementMessage({
        routeComplete: routeActuallyComplete,
        completed,
        total,
        timeOnDuty,
        hourlyRate,
      });
      messageLockedRef.current = true;
    }
    setStats(newStats);

    // Only fire confetti when the route is fully complete
    if (routeActuallyComplete) {
      confetti({
        particleCount: 100,
        spread: 70,
        origin: { y: 0.6 },
        zIndex: 10100,
      });
    }
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
            <span style={{ color: 'var(--text-slate-900)' }}>{stats?.routeComplete ? 'Route Complete!' : 'Route Summary'}</span>
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

            {/* Completed / Pending — single card with split values when incomplete */}
            <div className="p-3 rounded-lg border text-center" style={{ background: 'var(--bg-emerald-50)', borderColor: 'var(--border-emerald-200)' }}>
              <CheckCircle className="w-5 h-5 mx-auto mb-1 text-emerald-600" />
              {!stats.routeComplete ? (
                <>
                  <div className="flex justify-center items-baseline gap-1.5">
                    <span className="text-2xl font-bold text-emerald-700">{stats.completed}</span>
                    <span className="text-base font-semibold text-slate-400">/</span>
                    <span className="text-2xl font-bold text-amber-600">{stats.pending}</span>
                  </div>
                  <div className="flex justify-center gap-2 mt-0.5">
                    <span className="text-xs text-emerald-600">Done</span>
                    <span className="text-xs text-slate-400">/</span>
                    <span className="text-xs text-amber-600">Pending</span>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex justify-center items-baseline gap-1.5">
                    <span className="text-2xl font-bold text-emerald-700">{stats.completed}</span>
                    <span className="text-2xl font-semibold text-emerald-500">/ {stats.total > 0 ? Math.min(100, Math.max(0, Math.round(((stats.total - stats.returned) / stats.total) * 100))) : 0}%</span>
                  </div>
                  <div className="text-xs text-emerald-600">Completed</div>
                </>
              )}
            </div>

            <div className="p-3 rounded-lg border text-center" style={{ background: 'var(--bg-red-50)', borderColor: 'var(--border-red-200)' }}>
              <XCircle className="w-5 h-5 mx-auto mb-1 text-red-600" />
              <div className="text-2xl font-bold text-red-700">{stats.failed} / {stats.returned}</div>
              <div className="text-xs text-red-600">Failed / Returns</div>
            </div>

            {/* Distance — single card, shows Total + Remaining when incomplete */}
            <div className="p-3 rounded-lg border text-center" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
              <MapPin className="w-5 h-5 mx-auto mb-1 text-slate-600" />
              {stats.estimatedDistance != null ? (
                // Not started — show full est. total
                <>
                  <div className="text-lg font-bold" style={{ color: 'var(--text-slate-900)' }}>{stats.estimatedDistance} km</div>
                  <div className="text-xs" style={{ color: 'var(--text-slate-600)' }}>Est. Distance</div>
                </>
              ) : stats.remainingDistance != null ? (
                // In progress — show actual total + remaining est.
                <>
                  <div className="flex justify-center items-baseline gap-1.5">
                    <span className="text-lg font-bold" style={{ color: 'var(--text-slate-900)' }}>{stats.totalDistance}</span>
                    <span className="text-xs font-semibold text-slate-400">+{stats.remainingDistance}</span>
                    <span className="text-xs" style={{ color: 'var(--text-slate-500)' }}>km</span>
                  </div>
                  <div className="flex justify-center gap-2 mt-0.5">
                    <span className="text-xs" style={{ color: 'var(--text-slate-600)' }}>Done</span>
                    <span className="text-xs text-slate-400">/</span>
                    <span className="text-xs" style={{ color: 'var(--text-slate-500)' }}>Est. Rem.</span>
                  </div>
                </>
              ) : (
                // Complete
                <>
                  <div className="text-lg font-bold" style={{ color: 'var(--text-slate-900)' }}>{stats.totalDistance} km</div>
                  <div className="text-xs" style={{ color: 'var(--text-slate-600)' }}>Total Distance</div>
                </>
              )}
              {(parseFloat(stats.drivingDistance) > 0 && parseFloat(stats.cyclingDistance) > 0) && (
                <div className="flex justify-center gap-3 mt-1.5 pt-1.5 border-t" style={{ borderColor: 'var(--border-slate-200)' }}>
                  <div className="flex items-center gap-1">
                    <Car className="w-3 h-3 text-blue-600 shrink-0" />
                    <span className="text-xs font-medium text-blue-700">{stats.drivingDistance} km</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <Bike className="w-3 h-3 text-green-600 shrink-0" />
                    <span className="text-xs font-medium text-green-700">{stats.cyclingDistance} km</span>
                  </div>
                </div>
              )}
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
          {encouragementRef.current && (() => {
            const { emoji, text, color } = encouragementRef.current;
            const bgVar = color === 'emerald' ? 'var(--bg-emerald-50)' : 'var(--bg-blue-50)';
            const borderVar = color === 'emerald' ? 'var(--border-emerald-200)' : 'var(--border-blue-200)';
            const textClass = color === 'emerald' ? 'text-emerald-700' : 'text-blue-700';
            const bestDay = stats?.bestDayByStops;
            const bestDayLabel = bestDay
              ? format(new Date(bestDay.date + 'T00:00:00'), 'MMM d')
              : null;
            const isNewRecord = bestDay && stats.total >= bestDay.stops && deliveryDate === bestDay.date;
            return (
              <div className="text-center py-3 px-4 rounded-lg border" style={{ background: bgVar, borderColor: borderVar }}>
                <p className={`text-sm font-medium ${textClass}`}>{emoji} {text}</p>
                {bestDay && (
                  <p className="text-xs mt-1.5 opacity-70" style={{ color: color === 'emerald' ? 'var(--text-emerald-700)' : 'var(--text-blue-700)' }}>
                    {isNewRecord ? '🏆 New record! ' : ''}Best Day: {bestDayLabel} — {bestDay.stops} Stop{bestDay.stops !== 1 ? 's' : ''}
                  </p>
                )}
              </div>
            );
          })()}

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