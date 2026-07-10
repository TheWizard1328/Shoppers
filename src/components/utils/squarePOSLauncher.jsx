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

  const resolvedCallbackUrl = callbackUrl || (window.location.origin + window.location.pathname);

  if (platform === 'ios') {
    const payload = {
      client_id: squareAppId,
      version: '1.3',
      callback_url: resolvedCallbackUrl,
      amount_money: { amount: Math.round(amountCents), currency_code: currencyCode },
    };
    if (notes) payload.notes = notes;
    if (locationId) payload.location_id = locationId;
    const encoded = encodeURIComponent(JSON.stringify(payload));
    const squareUrl = `square-commerce-v1://payment/create?data=${encoded}`;

    remoteLogger.info('[Square POS] (iOS) Launching', squareUrl);

    try {
      const a = document.createElement('a');
      a.href = squareUrl;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { try { document.body.removeChild(a); } catch (_) {} }, 1000);
      remoteLogger.info('[Square POS] (iOS) Anchor click dispatched successfully');
    } catch (err) {
      remoteLogger.error('[Square POS] (iOS) Anchor click FAILED', String(err));
    }
    return;
  }

  // ── Android Mobile Web format — Android Intent URI ────────────────────
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
  const squareUrl = `intent:#Intent;${parts.join(';')};end`;

  remoteLogger.info('[Square POS] (Android) Intent URL built', squareUrl);
  console.log('[Square POS] (Android) Launching URL:', squareUrl);

  try {
    window.open(squareUrl);
    remoteLogger.info('[Square POS] (Android) window.open dispatched successfully');
  } catch (err) {
    remoteLogger.error('[Square POS] (Android) window.open FAILED', String(err));
    console.error('[Square POS] Launch error:', err);
  }
}