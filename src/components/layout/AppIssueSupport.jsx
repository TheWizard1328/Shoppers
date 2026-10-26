import { useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { getDeviceIdentifier } from '@/components/utils/userSettingsManager';

/**
 * AppIssueSupport — client side of the App Issue Monitor (Oct 11 2026).
 *
 * Two responsibilities, both headless (renders nothing):
 *
 * 1. Restart detection beacon: one RemoteLogEntry (event_type 'app_start')
 *    per authenticated page load. The scheduled appIssueMonitor backend
 *    function counts these per user to detect "frequent app restarts".
 *    Written directly (not via remoteLogger) so it is NOT gated by the
 *    RemoteLoggingSettings capture config — restart detection must work
 *    for every user, even when console capture is disabled. One tiny entity
 *    write per app open.
 *
 * 2. Push deep link: owner push notifications from "App Issues" carry
 *    ?app_issue_message=<id>. Handled on mount (killed-app taps open the
 *    PWA fresh at the URL) and on popstate (native push tap navigates via
 *    pushState + popstate while the app is warm). Validates the message
 *    belongs to the current user, then opens the App Issues conversation
 *    in the messaging panel (same UX as the driver-availability deep link).
 */

// Module-level: log at most once per page load, even if this component
// remounts (React StrictMode double-mount, layout re-renders, etc).
let startBeaconSent = false;

function cleanAppIssueParam() {
  try {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('app_issue_message')) return;
    params.delete('app_issue_message');
    const qs = params.toString();
    window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash);
  } catch (_) { /* non-critical */ }
}

export default function AppIssueSupport({ currentUser }) {
  const userId = currentUser?.id;
  const userName = currentUser?.full_name || currentUser?.user_name || currentUser?.email || null;

  // (1) Restart-detection beacon — once per page load, fire-and-forget.
  useEffect(() => {
    if (startBeaconSent || !userId) return;
    startBeaconSent = true;
    base44.entities.RemoteLogEntry.create({
      level: 'info',
      message: '[DEVICE_HEALTH] app_start | App started',
      event_type: 'app_start',
      timestamp: new Date().toISOString(),
      user_id: userId,
      user_name: userName,
      device_identifier: getDeviceIdentifier(),
      metadata: { source: 'app_issue_monitor', host: (typeof window !== 'undefined' && window.location?.hostname) ? window.location.hostname : null },
    }).catch(() => {});
  }, [userId, userName]);

  // (2) Push deep link → open the App Issues conversation.
  useEffect(() => {
    const handleDeepLink = () => {
      const params = new URLSearchParams(window.location.search);
      const msgId = params.get('app_issue_message');
      if (!msgId) return;
      cleanAppIssueParam();
      if (!userId) return;
      (async () => {
        try {
          const msg = await base44.entities.Message.get(msgId);
          if (msg && msg.receiver_id === userId) {
            window.dispatchEvent(new CustomEvent('openAppIssueConversation'));
          }
        } catch (_) { /* message may be gone — nothing to open */ }
      })();
    };
    handleDeepLink();
    // popstate: native push taps navigate via pushState + popstate while warm.
    window.addEventListener('popstate', handleDeepLink);
    return () => window.removeEventListener('popstate', handleDeepLink);
  }, [userId]);

  return null;
}
