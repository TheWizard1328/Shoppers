/**
 * Square Point of Sale mobile launcher.
 *
 * Uses window.location.href to navigate to the square-commerce-v1:// custom scheme.
 * On Android WebView / Capacitor, shouldOverrideUrlLoading intercepts the navigation
 * and hands it to the Android intent system, opening Square POS directly.
 *
 * IMPORTANT: Call this synchronously within a user gesture handler (onPointerDown / onClick).
 * Do NOT await anything before calling this — async gaps break gesture trust on Android WebView.
 * Do NOT pass location_id — Square uses whichever location is active in the POS app.
 */
export function launchSquarePOS({ squareAppId, amountCents, currencyCode = 'CAD', callbackUrl, notes }) {
  console.log('[Square POS] launchSquarePOS called', { squareAppId, amountCents, notes });

  if (!squareAppId) {
    console.warn('[Square POS] squareAppId not configured');
    return;
  }

  // Minimal payload — no location_id, no extra fields that could confuse Square POS
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

  const encoded = encodeURIComponent(JSON.stringify(payload));
  const squareUrl = `square-commerce-v1://payment/create?data=${encoded}`;

  console.log('[Square POS] Payload:', JSON.stringify(payload));
  console.log('[Square POS] Launching URL:', squareUrl);

  // window.location.href is the most reliable way to trigger a custom URI scheme
  // inside an Android WebView — the OS intercepts it and opens the registered app.
  window.location.href = squareUrl;
}