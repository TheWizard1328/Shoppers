Deno.serve(async (req: Request): Promise<Response> => {
  try {
    // Parse any Square response params from the URL so we can pass them back
    const url = new URL(req.url);
    const status = url.searchParams.get('status') || '';
    const errorCode = url.searchParams.get('error_code') || '';
    const transactionId = url.searchParams.get('transaction_id') || '';

    // Build redirect back to the app root, forwarding Square's response params.
    // iOS Safari PWA navigates to this callback URL after payment (success or cancel).
    // We redirect back to the app root so the PWA resumes from where the driver left off.
    const appOrigin = url.origin;
    const redirectParams = new URLSearchParams();
    if (status) redirectParams.set('square_status', status);
    if (errorCode) redirectParams.set('square_error', errorCode);
    if (transactionId) redirectParams.set('square_txn', transactionId);

    const qs = redirectParams.toString();
    const redirectTo = `${appOrigin}/${qs ? '?' + qs : ''}`;

    return new Response(null, {
      status: 302,
      headers: {
        'Location': redirectTo,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});