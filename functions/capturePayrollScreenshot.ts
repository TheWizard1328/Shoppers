import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { html, width = 1200, height = 800 } = await req.json();

    if (!html) {
      return Response.json({ error: 'HTML content required' }, { status: 400 });
    }

    // Use Playwright for server-side rendering
    const playwright = await import('npm:playwright@1.40.1');
    const browser = await playwright.chromium.launch();
    const context = await browser.createBrowserContext();
    const page = await context.newPage();

    // Set viewport size for consistent rendering
    await page.setViewportSize({ width, height });

    // Load the HTML content
    await page.setContent(html, { waitUntil: 'networkidle' });

    // Take screenshot
    const screenshot = await page.screenshot({ type: 'png', fullPage: true });

    // Cleanup
    await context.close();
    await browser.close();

    // Convert to base64 data URL
    const base64 = btoa(String.fromCharCode(...new Uint8Array(screenshot)));
    const dataUrl = `data:image/png;base64,${base64}`;

    return Response.json({ imageData: dataUrl });
  } catch (error) {
    console.error('Screenshot error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});