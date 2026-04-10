// Redeployed on 2026-04-09
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    await req.text().catch(() => '');
    const response = await base44.functions.invoke('squareCodCore', {
      action: 'syncCatalogItems',
    });

    return Response.json(response?.data || response, { status: response?.status || 200 });
  } catch (error) {
    return Response.json({ error: error?.message || 'Internal Server Error' }, { status: 500 });
  }
});