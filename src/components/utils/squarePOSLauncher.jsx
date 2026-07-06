import { remoteLogger } from '@/components/utils/remoteLogger';

/**
 * Square Point of Sale mobile launcher.
 *
 * Dispatches a square-commerce-v1:// URI via a hidden <a target="_blank"> click.
 * This keeps gesture trust intact on Android WebView and avoids navigating the
 * PWA away from the current page (which window.location.href would do).
 *
 * IMPORTANT: Call this synchronously within a user gesture handler (onPointerDown).
 * Do NOT pass location_id — Square uses whichever location is active in the POS app.
 */
export function launchSquarePOS({ squareAppId, amountCents, currencyCode = 'CAD', callbackUrl, notes }) {
  remoteLogger.info('[Square POS] launchSquarePOS called', JSON.stringify({ squareAppId: squareAppId ? squareAppId.slice(0, 8) + '...' : null, amountCents, currencyCode, notes }));

  if (!squareAppId) {
    remoteLogger.error('[Square POS] FAILED — squareAppId is missing or empty');
    console.warn('[Square POS] squareAppId not configured');
    return;
  }

  if (!amountCents || amountCents <= 0) {
    remoteLogger.error('[Square POS] FAILED — amountCents is zero or invalid', String(amountCents));
    console.warn('[Square POS] amountCents invalid', amountCents);
    return;
  }

  // Minimal payload — no location_id so Square uses its currently active location
  const payload = {
    client_id: squareAppId,
    version: '1.3',
    amount_money: {
      amount: Math.round(amountCents),
      currency_code: currencyCode,
    },
  };

  if (notes) payload.notes = notes;
  if (callbackUrl) payload.callback_url = callbackUrl;

  const payloadJson = JSON.stringify(payload);
  const encoded = encodeURIComponent(payloadJson);
  const squareUrl = `square-commerce-v1://payment/create?data=${encoded}`;

  remoteLogger.info('[Square POS] Payload built', payloadJson);
  remoteLogger.info('[Square POS] URL length', String(squareUrl.length));
  console.log('[Square POS] Payload:', payloadJson);
  console.log('[Square POS] Launching URL:', squareUrl);

  // Use window.location.href for custom URI schemes on Android.
  // target="_blank" on Android Chrome/WebView blocks intent:// and custom schemes;
  // direct assignment is the reliable way to hand off to another app.
  try {
    window.location.href = squareUrl;
    remoteLogger.info('[Square POS] window.location.href set successfully');
  } catch (err) {
    remoteLogger.error('[Square POS] Launch FAILED', String(err));
    console.error('[Square POS] Launch error:', err);
  }
}