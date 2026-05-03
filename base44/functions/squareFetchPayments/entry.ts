// Redeployed on 2026-04-09
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const payload = await req.json().catch(() => ({}));
    const response = {
      data: {
        success: true,
        paused: true,
        paymentsCount: 0,
        transactions: [],
        soldItems: [],
        soldCatalogItems: [],
        catalogItems: [],
        catalogItemCount: 0,
        dateRange: null,
      },
      status: 200,
    };

    return Response.json(response?.data || response, { status: response?.status || 200 });
  } catch (error) {
    return Response.json({ error: error?.message || 'Internal Server Error' }, { status: 500 });
  }
});