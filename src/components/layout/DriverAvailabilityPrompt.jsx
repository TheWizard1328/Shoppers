import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Radio, Loader2, CheckCircle2, XCircle } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { userHasRole } from '../utils/userRoles';

/**
 * DriverAvailabilityPrompt
 * ----------------------------------------------------------------------------
 * In-app Yes/No prompt for an active Driver Availability Request targeting
 * the logged-in driver. Mounted in GlobalOverlays (layout level) so it works
 * on every page.
 *
 * WHY THIS EXISTS:
 * Pickup-request pushes used to be data-only FCM messages, which are only
 * visible while the app's JS layer is alive. When the app was cleared from
 * memory, the driver saw nothing. Pushes now carry a `notification` payload
 * (OS displays them even with the app killed), but tapping one cold-starts
 * the app without the URL routing — and the OS-displayed notification has no
 * Yes/Unavailable buttons. This prompt closes the loop:
 *
 *   1. On mount, ask driverAvailabilityManager (get_pending_for_driver) for
 *      any active, unanswered request targeting this driver — covers killed
 *      app taps, missed pushes, even notifications dismissed by mistake.
 *   2. Also watch the URL for ?availability_request=<id> (the push tap
 *      handler navigates here when the app is already running).
 *
 * Response parity with the notification buttons: yes → completed + Message
 * to dispatcher; no → recorded / triggers escalation broadcast.
 */

function cleanUrlParam() {
  try {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('availability_request')) return;
    params.delete('availability_request');
    const qs = params.toString();
    window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash);
  } catch (_) { /* non-critical */ }
}

export default function DriverAvailabilityPrompt({ currentUser }) {
  const isDriver = !!(currentUser && userHasRole(currentUser, 'driver'));
  const [request, setRequest] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null); // 'yes' | 'no' | null
  const [error, setError] = useState(null);
  const handledRef = useRef(new Set());
  const checkingRef = useRef(false);

  const showRequest = useCallback((req) => {
    if (!req?.id || handledRef.current.has(req.id)) return;
    setRequest(req);
    setResult(null);
    setError(null);
  }, []);

  const checkPending = useCallback(async () => {
    if (!isDriver || !currentUser?.id || checkingRef.current) return;
    checkingRef.current = true;
    try {
      // URL param from a tapped push (native tap handler routes here when
      // the app is already running). Cleaned up regardless of what we show.
      const urlRequestId = new URLSearchParams(window.location.search).get('availability_request');
      cleanUrlParam();

      const res = await base44.functions.invoke('driverAvailabilityManager', { action: 'get_pending_for_driver' });
      if (res?.request) {
        showRequest(res.request);
        return;
      }
      // URL-requested one may not be "pending" by the strict check (e.g.
      // driver is not in assigned/broadcast lists but got a targeted
      // specific-driver ping) — fetch it directly and validate minimally.
      if (urlRequestId) {
        const r = await base44.functions.invoke('driverAvailabilityManager', { action: 'get_request', request_id: urlRequestId });
        const urlReq = r?.request;
        const active = urlReq && (urlReq.status === 'waiting' || urlReq.status === 'escalated');
        const mine = (urlReq?.assigned_driver_responses || []).some(resp => resp.driver_id === currentUser.id);
        if (active && !mine) showRequest(urlReq);
      }
    } catch (e) {
      console.warn('[DriverAvailabilityPrompt] pending check failed:', e?.message || e);
    } finally {
      checkingRef.current = false;
    }
  }, [isDriver, currentUser?.id, showRequest]);

  // Mount check (covers killed-app taps and missed pushes) + popstate
  // (native push tap navigates via pushState + popstate while app is warm).
  useEffect(() => {
    if (!isDriver) return;
    checkPending();
    const onPop = () => checkPending();
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [isDriver, checkPending]);

  const respond = useCallback(async (response) => {
    if (!request?.id || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await base44.functions.invoke('driverAvailabilityManager', {
        action: 'driver_response',
        request_id: request.id,
        response,
      });
      handledRef.current.add(request.id);
      if (res?.skipped === 'request_already_finalized') {
        // Someone else accepted it while we were looking at the prompt.
        setResult('finalized');
      } else {
        setResult(response);
      }
    } catch (e) {
      console.error('[DriverAvailabilityPrompt] response failed:', e?.message || e);
      setError(e?.message || 'Failed to send response — try again.');
    } finally {
      setSubmitting(false);
    }
  }, [request, submitting]);

  const close = useCallback(() => {
    if (request?.id) handledRef.current.add(request.id);
    setRequest(null);
    setResult(null);
    setError(null);
  }, [request?.id]);

  if (!isDriver) return null;

  return (
    <Dialog open={!!request} onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent className="sm:max-w-md" aria-describedby="driver-availability-desc">
        {result ? (
          <div className="pt-2 pb-4 text-center">
            {result === 'yes' && (
              <>
                <CheckCircle2 className="w-12 h-12 mx-auto text-green-500 mb-3" />
                <h3 className="text-lg font-semibold mb-1">You're marked available</h3>
                <p className="text-sm text-muted-foreground">
                  {request?.dispatcher_name || 'The dispatcher'} has been notified — they'll message you shortly.
                </p>
              </>
            )}
            {result === 'no' && (
              <>
                <XCircle className="w-12 h-12 mx-auto text-muted-foreground mb-3" />
                <h3 className="text-lg font-semibold mb-1">Noted — you're unavailable</h3>
                <p className="text-sm text-muted-foreground">The dispatcher has been informed.</p>
              </>
            )}
            {result === 'finalized' && (
              <>
                <Radio className="w-12 h-12 mx-auto text-muted-foreground mb-3" />
                <h3 className="text-lg font-semibold mb-1">Already resolved</h3>
                <p className="text-sm text-muted-foreground">This pickup request was already handled.</p>
              </>
            )}
            <Button onClick={close} className="mt-4 w-full">Close</Button>
          </div>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Radio className="w-5 h-5 text-green-500 animate-pulse" />
                Pickup Request
              </DialogTitle>
            </DialogHeader>
            <div id="driver-availability-desc" className="space-y-2 py-1">
              <p className="text-sm font-medium">
                {request?.store_name || 'Your store'} is requesting a driver for pickup.
              </p>
              {request?.extra_info && (
                <p className="text-sm text-muted-foreground">{request.extra_info}</p>
              )}
              <p className="text-xs text-muted-foreground">
                From {request?.dispatcher_name || 'Dispatcher'}
                {request?.status === 'escalated' ? ' · broadcast to all city drivers' : ''}
              </p>
              {error && <p className="text-sm text-red-500">{error}</p>}
            </div>
            <DialogFooter className="flex-col-reverse sm:flex-col gap-2">
              <Button
                onClick={() => respond('yes')}
                disabled={submitting}
                className="w-full bg-green-600 hover:bg-green-700 text-white"
              >
                {submitting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                Yes, I'm available
              </Button>
              <Button
                onClick={() => respond('no')}
                disabled={submitting}
                variant="outline"
                className="w-full"
              >
                Unavailable
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
