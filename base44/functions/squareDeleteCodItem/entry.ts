// Redeployed on 2026-05-01
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

const isNotFoundError = (error) =>
  error?.status === 404 ||
  error?.response?.status === 404 ||
  String(error?.message || '').toLowerCase().includes('not found');

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const payload = await req.json().catch(() => ({}));
    const response = await base44.functions.invoke('squareCodCore', {
      action: 'deleteCodItem',
      ...payload,
    });

    return Response.json(response?.data || response, { status: response?.status || 200 });
  } catch (error) {
    if (isNotFoundError(error)) {
      return Response.json({ success: true, already_deleted: true }, { status: 200 });
    }

    const status = error?.status || error?.response?.status || 500;
    const message = error?.response?.data?.error || error?.message || 'Internal Server Error';
    return Response.json({ error: message }, { status });
  }
});