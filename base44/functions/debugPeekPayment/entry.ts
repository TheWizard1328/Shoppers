import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const SQUARE_BASE_URL = 'https://connect.squareup.com';
const SQUARE_VERSION = '2025-01-23';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const isAuthenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (isAuthenticated) {
      const user = await base44.auth.me().catch(() => null);
      if (user && !['admin', 'app_owner'].includes(String(user.role || '').toLowerCase())) {
        return Response.json({ error: 'Forbidden' }, { status: 403 });
      }
    }
    const accessToken = Deno.env.get('SQUARE_ACCESS_TOKEN');
    if (!accessToken) return Response.json({ error: 'no token' }, { status: 500 });

    const payload = await req.json().catch(() => ({}));
    const paymentId = payload?.paymentId || 'H7iv2sfWdedM0h71tkEEhem9sJDZY';

    const payResp = await fetch(`${SQUARE_BASE_URL}/v2/payments/${paymentId}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Square-Version': SQUARE_VERSION,
      },
    });
    const payJson = await payResp.json();

    let orderJson = null;
    const orderId = payJson?.payment?.order_id;
    if (orderId) {
      const orderResp = await fetch(`${SQUARE_BASE_URL}/v2/orders/${orderId}`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Square-Version': SQUARE_VERSION,
        },
      });
      orderJson = await orderResp.json();
    }

    // Also check bank-accounts / transfers / disputes endpoints that might carry loan/savings deductions
    let bankTransfers = null;
    try {
      const btResp = await fetch(`${SQUARE_BASE_URL}/v2/bank-accounts`, {
        headers: { Authorization: `Bearer ${accessToken}`, 'Square-Version': SQUARE_VERSION },
      });
      bankTransfers = await btResp.json();
    } catch (e) {
      bankTransfers = { error: String(e) };
    }

    return Response.json({ payment: payJson, order: orderJson, bankAccounts: bankTransfers });
  } catch (error) {
    return Response.json({ error: error?.message || String(error) }, { status: 500 });
  }
});
