// Square POS Web API callback endpoint.
// Square requires a valid HTTPS WEB_CALLBACK_URI — this page satisfies that requirement.
// Android fires this URL immediately when the intent resolves (before payment completes),
// so we return a minimal page that closes itself instantly with no visible UI flash.

Deno.serve(async (req) => {
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>RxDeliver</title>
  <style>
    body { margin:0; background:#0f172a; }
  </style>
</head>
<body>
  <script>
    // Close this tab immediately — returns focus to whatever was open (RxDeliver PWA).
    window.close();
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
