/**
 * Square Point of Sale mobile launcher.
 *
 * On Android/iOS inside Capacitor's WebView, `window.location.href` with a custom
 * scheme triggers shouldOverrideUrlLoading which hands the URL to the Android intent
 * system — opening Square POS directly.
 *
 * On desktop/web it falls through to a no-op (no Square app available anyway).
 */
export function launchSquarePOS({ squareAppId, amountCents, currencyCode = 'CAD', callbackUrl, notes }) {
  console.log('[Square POS] launchSquarePOS called', { squareAppId, amountCents });

  if (!squareAppId) {
    console.warn('[Square POS] squareAppId not configured');
    return;
  }

  const payload = {
    client_id: squareAppId,
    amount_money: { amount: Math.round(amountCents), currency_code: currencyCode }, 
    notes: notes,
    version: '1.3',
  };

  if (callbackUrl) payload.callback_url = callbackUrl;
  //if (notes) payload.notes = null; //notes;

  const encoded = encodeURIComponent(JSON.stringify(payload));
  const squareUrl = `square-commerce-v1://payment/create?data=${encoded}`;

  console.warn('[Square POS] Payload:', payload);
  console.log('[Square POS] Opening URL:', squareUrl);

  // Use hidden <a> tag click — most reliable cross-platform method for custom URI schemes
  // Works in PWA, browser, and native WebView contexts
  console.log('[Square POS] Launching via anchor click:', squareUrl);
  const a = document.createElement('a');
  a.href = squareUrl;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => document.body.removeChild(a), 1000);
}