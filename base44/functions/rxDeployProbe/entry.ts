import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

/** Temporary deployment probe — confirms git pushes deploy backend functions. */
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    return Response.json({ ok: true, probe: 'v1', echo: body?.echo || null, at: new Date().toISOString() });
  } catch (error) {
    return Response.json({ ok: false, error: error?.message }, { status: 500 });
  }
});
