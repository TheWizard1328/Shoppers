import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { startDate, endDate, storeId } = await req.json();

    // Build filter
    const filter = {};
    if (startDate) filter.delivery_date = { $gte: startDate };
    if (endDate) filter.delivery_date = { ...filter.delivery_date, $lte: endDate };
    if (storeId) filter.store_id = storeId;

    // Fetch deliveries
    const deliveries = await base44.entities.Delivery.filter(filter, '-delivery_date', 10000);

    // Fetch stores for name matching
    const stores = await base44.entities.Store.list();
    const storeNames = stores.map(s => s.name?.toLowerCase());

    // Count deliveries with store name AND "return" in patient_name or notes
    const returnDeliveries = deliveries.filter(delivery => {
      const patientName = (delivery.patient_name || '').toLowerCase();
      const notes = (delivery.delivery_notes || '').toLowerCase();
      const combinedText = `${patientName} ${notes}`;

      // Check if contains "return" or "(rtn)"
      const hasReturnKeyword = combinedText.includes('return') || combinedText.includes('(rtn)');
      
      // Check if contains any store name
      const hasStoreName = storeNames.some(storeName => combinedText.includes(storeName));

      return hasReturnKeyword && hasStoreName;
    });

    // Group by store
    const returnsByStore = {};
    returnDeliveries.forEach(delivery => {
      const store = stores.find(s => s.id === delivery.store_id);
      const storeName = store?.name || 'Unknown Store';
      
      if (!returnsByStore[storeName]) {
        returnsByStore[storeName] = {
          count: 0,
          storeId: delivery.store_id,
          deliveries: []
        };
      }
      
      returnsByStore[storeName].count++;
      returnsByStore[storeName].deliveries.push({
        id: delivery.id,
        delivery_id: delivery.delivery_id,
        patient_name: delivery.patient_name,
        delivery_date: delivery.delivery_date,
        notes: delivery.delivery_notes
      });
    });

    return Response.json({
      totalReturns: returnDeliveries.length,
      returnsByStore,
      dateRange: { startDate, endDate }
    });

  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});