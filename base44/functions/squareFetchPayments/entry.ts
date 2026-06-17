import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const payload = await req.json().catch(() => ({}));
    const response = await base44.functions.invoke('squareCodCore', {
      action: 'fetchPayments',
      ...payload,
    });

    return Response.json(response?.data || response, { status: response?.status || 200 });
  } catch (error) {
    return Response.json({ error: error?.message || 'Internal Server Error' }, { status: 500 });
  }
});