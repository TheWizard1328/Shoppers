import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

const SQUARE_BASE_URL = 'https://connect.squareup.com/v2';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const accessToken = Deno.env.get('SQUARE_ACCESS_TOKEN');
    if (!accessToken) {
      return Response.json({ error: 'Square credentials not configured' }, { status: 500 });
    }

    // Get location IDs from query params
    const { locationIds, daysBack = 7 } = await req.json();

    if (!locationIds || locationIds.length === 0) {
      return Response.json({ error: 'No location IDs provided' }, { status: 400 });
    }

    // Calculate date range (last N days)
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysBack);

    const allPayments = [];
    const soldCatalogItems = []; // Array of sold items with location details

    // Fetch payments for each location
    for (const locationId of locationIds) {
      let cursor = null;
      
      do {
        const searchBody = {
          location_ids: [locationId],
          begin_time: startDate.toISOString(),
          end_time: endDate.toISOString(),
          sort_order: 'DESC',
          limit: 100
        };

        if (cursor) {
          searchBody.cursor = cursor;
        }

        const paymentsResponse = await fetch(`${SQUARE_BASE_URL}/payments`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'Square-Version': '2024-01-18'
          },
          body: JSON.stringify(searchBody)
        });

        if (!paymentsResponse.ok) {
          console.error(`Failed to fetch payments for location ${locationId}:`, await paymentsResponse.text());
          continue;
        }

        const paymentsData = await paymentsResponse.json();
        
        if (paymentsData.payments) {
          for (const payment of paymentsData.payments) {
            // Only process completed payments
            if (payment.status !== 'COMPLETED') continue;

            allPayments.push(payment);

            // Fetch order details to get line items
            if (payment.order_id) {
              const orderResponse = await fetch(`${SQUARE_BASE_URL}/orders/${payment.order_id}`, {
                method: 'GET',
                headers: {
                  'Authorization': `Bearer ${accessToken}`,
                  'Content-Type': 'application/json',
                  'Square-Version': '2024-01-18'
                }
              });

              if (orderResponse.ok) {
                const orderData = await orderResponse.json();
                const order = orderData.order;

                // Extract catalog items from line items
                if (order?.line_items) {
                  for (const lineItem of order.line_items) {
                    if (lineItem.catalog_object_id) {
                      // Store each sold item with its location and payment details
                      soldCatalogItems.push({
                        catalog_object_id: lineItem.catalog_object_id,
                        location_id: payment.location_id,
                        payment_id: payment.id,
                        order_id: payment.order_id,
                        item_name: lineItem.name,
                        amount: lineItem.base_price_money?.amount ? lineItem.base_price_money.amount / 100 : 0,
                        payment_date: payment.created_at
                      });
                    }
                  }
                }
              }
            }
          }
        }

        cursor = paymentsData.cursor;
      } while (cursor);
    }

    // Count occurrences for backward compatibility
    const soldItemCounts = new Map();
    soldCatalogItems.forEach(item => {
      const count = soldItemCounts.get(item.catalog_object_id) || 0;
      soldItemCounts.set(item.catalog_object_id, count + 1);
    });
    
    const soldItems = Array.from(soldItemCounts.entries()).map(([catalogId, count]) => ({
      catalog_object_id: catalogId,
      times_sold: count
    }));

    return Response.json({
      success: true,
      paymentsCount: allPayments.length,
      soldItems,
      soldCatalogItems, // Detailed list of sold items with location info
      dateRange: {
        start: startDate.toISOString(),
        end: endDate.toISOString()
      }
    });

  } catch (error) {
    console.error('Error fetching Square payments:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});