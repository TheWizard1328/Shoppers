import { remoteLogger } from '@/components/utils/remoteLogger';

/**
 * Square Point of Sale mobile-web launcher.
 *
 * Square's Mobile Web integration uses TWO DIFFERENT, NON-INTERCHANGEABLE URI formats
 * depending on platform (https://developer.squareup.com/docs/pos-api/build-mobile-web):
 *
 *   - iOS:     square-commerce-v1://payment/create?data={percent-encoded JSON}
 *              dispatched via a same-frame navigation (hidden <a> click).
 *
 *   - Android: an Android "intent:" URI — intent:#Intent;action=...;package=com.squareup;
 *              S.com.squareup.pos.*=...;end — dispatched via window.open(). This is
 *              Chrome's first-class, documented mechanism for handing off to a native
 *              Android app from web content; a bare square-commerce-v1:// scheme is NOT
 *              reliably honored by Android Chrome/WebView from a plain web page.
 *
 * Our driver fleet is 100% Android (confirmed via remote logs), and the previous version
 * of this file only ever built the iOS-style payload — every tap completed the full JS
 * chain successfully (payload built, anchor click dispatched) but Square never opened,
 * because Android was silently ignoring the wrong URI format. This version detects
 * platform and builds the correct request for each.
 *
 * IMPORTANT: Call this synchronously within a user gesture handler (onPointerDown/onClick) —
 * any await/state update before this call can break gesture trust needed for the handoff.
 */

function isIOS() {
  const ua = navigator?.userAgent || '';
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  // iPadOS 13+ reports as MacIntel with touch support
  return navigator?.platform === 'MacIntel' && (navigator?.maxTouchPoints || 0) > 1;
}

export function launchSquarePOS({ squareAppId, amountCents, currencyCode = 'CAD', callbackUrl, notes, locationId }) {
  const platform = isIOS() ? 'ios' : 'android';
  remoteLogger.info('[Square POS] launchSquarePOS called', JSON.stringify({
    squareAppId: squareAppId ? squareAppId.slice(0, 8) + '...' : null,
    amountCents, currencyCode, notes, locationId: locationId || null, platform,
  }));

  if (!squareAppId) {
    remoteLogger.error('[Square POS] FAILED — squareAppId is missing or empty');
    console.warn('[Square POS] squareAppId not configured');
    return;
  }

  // Platform-specific callback URLs — these must point to the native app store page,
  // NOT a web URL. When Square finishes payment and redirects, opening the app store
  // URL causes the OS to deep-link back into the already-installed native app (PWA/APK).
  // Using a plain web URL would open the browser instead, breaking the return flow.
  const IOS_CALLBACK_URL = 'https://apps.apple.com/app/rxdeliver/id0000000000'; // TODO: replace with real App Store ID
  const ANDROID_CALLBACK_URL = 'https://play.google.com/store/apps/details?id=com.rxdeliver.app'; // existing working Android callback
  const platformCallbackUrl = isIOS() ? IOS_CALLBACK_URL : ANDROID_CALLBACK_URL;
  const resolvedCallbackUrl = callbackUrl || platformCallbackUrl;

  // Bare launch — open Square POS without a payment payload (no amount/tender).
  // Used on first COD of the day or location mismatch so driver can set their location first.
  const bare = !amountCents || amountCents <= 0;

  if (platform === 'ios') {
    const payload = { client_id: squareAppId, version: '1.3', callback_url: resolvedCallbackUrl };
    if (!bare) {
      payload.amount_money = { amount: Math.round(amountCents), currency_code: currencyCode };
      if (notes) payload.notes = notes;
      if (locationId) payload.location_id = locationId;
    }
    const encoded = encodeURIComponent(JSON.stringify(payload));
    const squareUrl = `square-commerce-v1://payment/create?data=${encoded}`;
    remoteLogger.info(`[Square POS] (iOS) Launching (bare=${bare})`, squareUrl);
    try {
      // iOS Safari/PWA: window.location.href is the only reliable way to launch
      // a custom URL scheme from a PWA or Safari web page. programmatic anchor
      // .click() is blocked in WKWebView/Safari when not directly in a gesture.
      window.location.href = squareUrl;
    } catch (err) {
      remoteLogger.error('[Square POS] (iOS) window.location.href FAILED', String(err));
    }
    return;
  }

  // ── Android Mobile Web format — Android Intent URI ────────────────────
  // Bare launch: use android.intent.action.MAIN with just the package — this simply
  // brings the Square POS app to the foreground without triggering any transaction flow.
  // The CHARGE action (even without an amount) causes Square to start its payment
  // controller which then errors/falls back when no valid transaction payload is present.
  let squareUrl;
  if (bare) {
    squareUrl = `intent:#Intent;action=android.intent.action.MAIN;package=com.squareup;end`;
  } else {
    const tenderTypes = [
      'com.squareup.pos.TENDER_CARD',
      'com.squareup.pos.TENDER_CARD_ON_FILE',
      'com.squareup.pos.TENDER_CASH',
      'com.squareup.pos.TENDER_OTHER',
    ].join(',');
    const parts = [
      'action=com.squareup.pos.action.CHARGE',
      'package=com.squareup',
      `S.com.squareup.pos.WEB_CALLBACK_URI=${encodeURIComponent(resolvedCallbackUrl)}`,
      `S.com.squareup.pos.CLIENT_ID=${encodeURIComponent(squareAppId)}`,
      'S.com.squareup.pos.API_VERSION=v2.0',
      `i.com.squareup.pos.TOTAL_AMOUNT=${Math.round(amountCents)}`,
      `S.com.squareup.pos.CURRENCY_CODE=${encodeURIComponent(currencyCode)}`,
      `S.com.squareup.pos.TENDER_TYPES=${encodeURIComponent(tenderTypes)}`,
    ];
    if (notes) parts.push(`S.com.squareup.pos.NOTE=${encodeURIComponent(notes)}`);
    if (locationId) parts.push(`S.com.squareup.pos.LOCATION_ID=${encodeURIComponent(locationId)}`);
    squareUrl = `intent:#Intent;${parts.join(';')};end`;
  }

  remoteLogger.info(`[Square POS] (Android) Intent URL built (bare=${bare})`, squareUrl);
  console.log('[Square POS] (Android) Launching URL:', squareUrl);

  try {
    window.open(squareUrl);
    remoteLogger.info('[Square POS] (Android) window.open dispatched successfully');
  } catch (err) {
    remoteLogger.error('[Square POS] (Android) window.open FAILED', String(err));
    console.error('[Square POS] Launch error:', err);
  }
}