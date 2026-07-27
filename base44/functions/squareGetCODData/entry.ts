// Updated 2026-07-27 - SDK version aligned with squareCodCore (0.8.25) to fix auth context forwarding
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const payload = await req.json().catch(() => ({}));
    const response = await base44.functions.invoke('squareGetCodData2', {
      action: 'getCodData',
      ...payload,
    });

    return Response.json(response?.data || response, { status: response?.status || 200 });
  } catch (error) {
    const nestedError = error?.response?.data || error?.response?.error || null;
    console.error('[squareGetCODData] invoke failed', {
      message: error?.message || 'Internal Server Error',
      status: error?.response?.status || null,
      nestedError,
    });
    return Response.json({
      error: error?.message || 'Internal Server Error',
      status: error?.response?.status || null,
      nestedError,
    }, { status: 500 });
  }
});
