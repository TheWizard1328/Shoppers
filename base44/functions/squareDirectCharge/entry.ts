// squareDirectCharge — processes a COD card payment server-side via Square Payments API.
// Uses the Personal Access Token (merchant-wide, not location-scoped) so no Square app
// location switching is required on the driver's device.
//
// Required payload: { deliveryId, locationId, amountCents, note }
// Returns: { success, paymentId, receiptUrl, status, amount, note }

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

const SQUARE_BASE_URL = 'https://connect.squareup.com';
const SQUARE_VERSION  = '2025-01-23';

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

function ensureToken(): string {
  const t = Deno.env.get('SQUARE_ACCESS_TOKEN_2') || Deno.env.get('SQUARE_ACCESS_TOKEN');
  if (!t) throw new HttpError(500, 'Square access token not configured (SQUARE_ACCESS_TOKEN_2)');
  return t;
}

async function squarePost(path: string, body: unknown, token: string): Promise<unknown> {
  const res = await fetch(`${SQUARE_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Square-Version': SQUARE_VERSION,
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) {
    const detail = json?.errors?.[0]?.detail || json?.errors?.[0]?.code || 'Square API error';
    throw new HttpError(res.status, detail);
  }
  return json;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);

    // Auth — must be a logged-in user (driver or admin)
    const user = await base44.auth.me().catch(() => null);
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const payload = await req.json().catch(() => ({}));
    const { deliveryId, locationId, amountCents, note } = payload || {};

    if (!deliveryId)   throw new HttpError(400, 'Missing required field: deliveryId');
    if (!locationId)   throw new HttpError(400, 'Missing required field: locationId');
    if (!amountCents || amountCents <= 0) throw new HttpError(400, 'Invalid amountCents');

    const token = ensureToken();

    // Create a Square payment using a card-on-file terminal flow.
    // NOTE: Square's Payments API for in-person card payments requires either:
    //   a) A device code / Terminal API (for card readers attached to a device), or
    //   b) A card nonce from the Web Payments SDK (for online card entry).
    //
    // For the POS app intent replacement, we use the Terminal API — create a checkout
    // that appears on the Square POS device already logged in at that location.
    // The driver taps "Charge" on the Square terminal screen.

    const idempotencyKey = `rxd-${deliveryId}-${Date.now()}`;

    const checkoutBody = {
      idempotency_key: idempotencyKey,
      checkout: {
        amount_money: {
          amount: amountCents,
          currency: 'CAD',
        },
        reference_id: deliveryId,
        note: note || '',
        payment_options: {
          autocomplete: true,
        },
        device_options: {
          // No device_id means Square will send to any available device at the location.
          // The driver confirms on the terminal itself.
          skip_receipt_screen: false,
        },
      },
    };

    const checkoutRes: any = await squarePost(
      `/v2/terminals/checkouts`,
      checkoutBody,
      token
    );

    const checkout = checkoutRes?.checkout;

    // Record a pending SquareTransaction so our sync picks it up
    await base44.asServiceRole.entities.SquareTransaction.create({
      square_transaction_id: checkout?.id || idempotencyKey,
      square_payment_id: checkout?.id || idempotencyKey,
      item_name: note || '',
      amount: amountCents / 100,
      amount_cents: amountCents,
      type: 'collection',
      status: 'pending',
      delivery_id: deliveryId,
      driver_id: user.id,
      location_id: locationId,
      payment_method: 'card',
      raw_square_data: {
        terminal_checkout_id: checkout?.id,
        idempotency_key: idempotencyKey,
        initiated_at: new Date().toISOString(),
        note: note || '',
      },
    }).catch(() => null); // non-fatal — sync will catch it anyway

    return Response.json({
      success: true,
      checkoutId: checkout?.id,
      status: checkout?.status,
      amount: amountCents / 100,
      note: note || '',
      message: 'Terminal checkout created — driver confirms on Square device',
    });

  } catch (err: any) {
    const status = err?.status || 500;
    console.error('[squareDirectCharge]', err?.message);
    return Response.json({ error: err?.message || 'Internal Server Error' }, { status });
  }
});
