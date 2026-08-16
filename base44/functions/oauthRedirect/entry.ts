// OAuth redirect bridge for native Android app.
//
// Base44's OAuth callback redirects to our `from_url` with ?access_token=... appended.
// We set from_url to THIS function's URL. When the callback hits us, we return a
// minimal HTML page that redirects to rxdeliver://auth?access_token=... — bringing
// the user back to the native app.
//
// This avoids dependency on PWA deployment timing: backend functions deploy
// instantly via the deploy_backend_function tool, unlike web app rebuilds which
// can take minutes or fail silently.
//
// Also provides a visible "Return to RxDeliver App" button as a fallback, since
// Chrome may block automatic custom-scheme navigation without a user gesture.

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const accessToken = url.searchParams.get('access_token');
  const refreshToken = url.searchParams.get('refresh_token');

  if (!accessToken) {
    return new Response('Missing access_token', { status: 400 });
  }

  const linkParams = new URLSearchParams({ access_token: accessToken });
  if (refreshToken) linkParams.set('refresh_token', refreshToken);
  const deepLink = `rxdeliver://auth?${linkParams.toString()}`;

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Returning to RxDeliver...</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #0f172a;
      color: #fff;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      gap: 20px;
      padding: 24px;
      text-align: center;
    }
    .icon {
      width: 72px; height: 72px;
      background: #2563EB;
      border-radius: 16px;
      display: flex; align-items: center; justify-content: center;
      font-size: 32px; font-weight: 700; color: #fff;
    }
    .status { font-size: 16px; color: #94a3b8; }
    .btn {
      display: inline-block;
      padding: 14px 32px;
      border-radius: 10px;
      background: #2563EB;
      color: #fff;
      font-weight: 600;
      font-size: 16px;
      text-decoration: none;
      border: none;
      cursor: pointer;
    }
    .hint { font-size: 13px; color: #64748b; max-width: 300px; }
  </style>
</head>
<body>
  <div class="icon">Rx</div>
  <p class="status">Signed in! Returning to the app...</p>
  <a href="${deepLink}" class="btn">Return to RxDeliver App</a>
  <p class="hint">Didn't switch automatically? Tap the button above.</p>
  <script>
    // Attempt automatic redirect to the custom scheme.
    // Chrome may block this without a user gesture - the button above is the fallback.
    window.location.href = "${deepLink}";
  </script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=UTF-8',
      'Cache-Control': 'no-store',
    },
  });
});
