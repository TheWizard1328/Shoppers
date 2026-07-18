import { remoteLogger } from '@/components/utils/remoteLogger';

/**
 * Square Point of Sale mobile-web launcher.
 *
 * Square's Mobile Web integration uses TWO DIFFERENT, NON-INTERCHANGEABLE URI formats
 * depending on platform (https://developer.squareup.com/docs/pos-api/build-mobile-web):
 *
 *   - iOS:     square-commerce-v1://payment/create?data={percent-encoded JSON}
 *              dispatched via a same-frame navigation (hidden <a> click).
 *              The JSON `data` object REQUIRES an `options.supported_tender_types` array —
 *              omitting it causes Square to open, reject the request as invalid, and
 *              immediately bounce back to the callback URL before the driver can interact.
 *
 *   - Android: an Android "intent:" URI — intent:#Intent;action=...;package=com.squareup;
 *              S.com.squareup.pos.*=...;end — dispatched via window.open(). This is
 *              Chrome's first-class, documented mechanism for handing off to a native
 *              Android app from web content; a bare square-commerce-v1:// scheme is NOT
 *              reliably honored by Android Chrome/WebView from a plain web page.
 *
 * BARE LAUNCHES (yellow triangle / first COD of day): Both platforms open the Square
 * POS app directly to its main screen WITHOUT triggering a payment/create flow. This
 * lets the driver manually check or switch their Square location before the real charge.
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

// iOS supported_tender_types values (different naming from Android's TENDER_* constants)
// https://developer.squareup.com/docs/pos-api/web-technical-reference#mobile-web-on-ios
const IOS_TENDER_TYPES = ['CREDIT_CARD', 'CASH', 'OTHER', 'SQUARE_GIFT_CARD', 'CARD_ON_FILE'];

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
  const IOS_CALLBACK_URL = 'https://apps.apple.com/app/square-point-of-sale-pos/id335393788';
  const ANDROID_CALLBACK_URL = 'https://play.google.com/store/apps/details?id=com.squareup';
  const platformCallbackUrl = isIOS() ? IOS_CALLBACK_URL : ANDROID_CALLBACK_URL;
  const resolvedCallbackUrl = callbackUrl || platformCallbackUrl;

  // Bare launch — open Square POS without a payment payload (no amount/tender).
  // Used on first COD of the day or location mismatch so driver can set their location first.
  const bare = !amountCents || amountCents <= 0;

  // ── BARE LAUNCH: just open the Square POS app directly, no payment flow ──
  // On iOS: call the custom URL scheme without /payment/create — this opens the app
  // to its main screen without triggering any transaction flow.
  // On Android: already handled below with android.intent.action.MAIN.
  if (bare && platform === 'ios') {
    const squareUrl = 'square-commerce-v1://';
    remoteLogger.info('[Square POS] (iOS) Bare launch — opening app directly', squareUrl);
    try {
      const a = document.createElement('a');
      a.href = squareUrl;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { try { document.body.removeChild(a); } catch (_) {} }, 1000);
    } catch (err) {
      remoteLogger.error('[Square POS] (iOS) bare anchor click FAILED', String(err));
    }
    return;
  }

  if (platform === 'ios') {
    // ── iOS Mobile Web format — square-commerce-v1://payment/create ────
    // The `options` object with `supported_tender_types` is REQUIRED by the iOS
    // Square POS app. Without it, Square opens, sees the request as invalid, and
    // immediately returns to the callback URL — which looks like "the callback
    // fires as soon as Square loads."
    const payload = {
      client_id: squareAppId,
      version: '1.3',
      callback_url: resolvedCallbackUrl,
      options: {
        supported_tender_types: IOS_TENDER_TYPES,
        skip_receipt: true,
        auto_return: true,
      },
    };

    payload.amount_money = { amount: Math.round(amountCents), currency_code: currencyCode };
    if (notes) payload.notes = notes;
    // if (locationId) payload.location_id = locationId; // TEMP: location_id removed from payload

    const encoded = encodeURIComponent(JSON.stringify(payload));
    const squareUrl = `square-commerce-v1://payment/create?data=${encoded}`;
    remoteLogger.info(`[Square POS] (iOS) Launching payment (bare=false)`, squareUrl);
    try {
      // iOS Safari/PWA: Use a hidden <a> tag click rather than window.location.href.
      // window.location.href navigates the current page away, causing Safari to immediately
      // fire the callback_url as a "fallback" when it can't confirm Square opened.
      // A programmatic anchor click hands off to the custom scheme without navigating away.
      const a = document.createElement('a');
      a.href = squareUrl;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { try { document.body.removeChild(a); } catch (_) {} }, 1000);
    } catch (err) {
      remoteLogger.error('[Square POS] (iOS) anchor click FAILED', String(err));
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
    // if (locationId) parts.push(`S.com.squareup.pos.LOCATION_ID=${encodeURIComponent(locationId)}`); // TEMP: location_id removed from payload
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