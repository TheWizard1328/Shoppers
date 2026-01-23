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

    // Fetch payments for each location (limit to first page to avoid CPU timeout)
    for (const locationId of locationIds) {
      // Build query string for GET request - fetch only first page (latest payments)
      const queryParams = new URLSearchParams({
        location_id: locationId,
        begin_time: startDate.toISOString(),
        end_time: endDate.toISOString(),
        sort_order: 'DESC',
        limit: '100'
      });

      const paymentsResponse = await fetch(`${SQUARE_BASE_URL}/payments?${queryParams.toString()}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Square-Version': '2024-01-18'
        }
      });

      if (!paymentsResponse.ok) {
        console.error(`Failed to fetch payments for location ${locationId}:`, await paymentsResponse.text());
        continue;
      }

      const paymentsData = await paymentsResponse.json();
      console.log(`📊 [SquareFetchPayments] Location ${locationId}: Got ${paymentsData.payments?.length || 0} payments`);
      
      if (paymentsData.payments) {
        // Limit to 30 payments to avoid CPU timeout
        const paymentsToProcess = paymentsData.payments.slice(0, 30);
        
        for (const payment of paymentsToProcess) {
          // Only process completed payments
          if (payment.status !== 'COMPLETED') continue;

          allPayments.push(payment);
          console.log(`📋 [SquareFetchPayments] Processing payment ${payment.id} at location ${payment.location_id}, order: ${payment.order_id}`);

          // Try to get order details if order_id exists
          if (payment.order_id) {
            try {
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
                if (order?.line_items && order.line_items.length > 0) {
                  console.log(`📦 [SquareFetchPayments] Order ${payment.order_id} has ${order.line_items.length} line items`);
                  for (const lineItem of order.line_items) {
                    if (lineItem.catalog_object_id) {
                      const soldItem = {
                        catalog_object_id: lineItem.catalog_object_id,
                        location_id: payment.location_id,
                        payment_id: payment.id,
                        square_transaction_id: payment.id,
                        square_payment_id: payment.id,
                        order_id: payment.order_id,
                        item_name: lineItem.name,
                        amount: lineItem.base_price_money?.amount ? lineItem.base_price_money.amount / 100 : 0,
                        payment_date: payment.created_at,
                        payment_method: payment.payment_source_type || 'UNKNOWN'
                      };
                      soldCatalogItems.push(soldItem);
                      console.log(`  ✅ [SquareFetchPayments] Found catalog item: ${soldItem.item_name} (${soldItem.catalog_object_id}) - $${soldItem.amount}`);
                    }
                  }
                } else {
                  console.log(`⚠️ [SquareFetchPayments] Order ${payment.order_id} has no line items with catalog IDs`);
                }
              } else {
                console.warn(`Failed to fetch order ${payment.order_id}:`, orderResponse.status);
              }
            } catch (orderErr) {
              console.warn(`Error fetching order ${payment.order_id}:`, orderErr.message);
            }
          } else {
            console.warn(`Payment ${payment.id} has no order_id - cannot retrieve line items`);
          }
        }
      }
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

    console.log(`🎯 [SquareFetchPayments] Summary: Found ${allPayments.length} payments, ${soldCatalogItems.length} sold catalog items`);
    console.log(`🎯 [SquareFetchPayments] Unique catalog IDs sold:`, Array.from(soldItemCounts.keys()));

    // Fetch current catalog items from Square
    let catalogItems = [];
    let catalogItemCount = 0;
    
    try {
      const catalogUrl = `${SQUARE_BASE_URL}/catalog/list?types=ITEM,ITEM_VARIATION`;
      const catalogResponse = await fetch(catalogUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Square-Version': '2024-01-18'
        }
      });

      if (catalogResponse.ok) {
        const catalogData = await catalogResponse.json();
        if (catalogData.objects) {
          // Process catalog items
          for (const obj of catalogData.objects) {
            if (obj.type === 'ITEM' && obj.item_data) {
              // Get variations and their prices
              if (obj.item_data.variations) {
                for (const variation of obj.item_data.variations) {
                  if (variation.item_variation_data) {
                    const priceMoney = variation.item_variation_data.price_money;
                    const priceDollars = priceMoney ? priceMoney.amount / 100 : 0;

                    // Check which locations have this item
                    for (const locationId of locationIds) {
                      const item = {
                        catalog_object_id: variation.id,
                        name: obj.item_data.name || variation.item_variation_data.name || 'Unnamed',
                        description: variation.item_variation_data.name,
                        price_dollars: priceDollars,
                        price_cents: priceMoney ? priceMoney.amount : 0,
                        location_id: locationId,
                        updated_at: obj.updated_at
                      };
                      catalogItems.push(item);
                      catalogItemCount++;
                    }
                  }
                }
              }
            }
          }
        }
      }
    } catch (err) {
      console.warn('Failed to fetch catalog items:', err);
    }

    return Response.json({
      success: true,
      paymentsCount: allPayments.length,
      soldItems,
      soldCatalogItems, // Detailed list of sold items with location info
      catalogItems, // Current catalog items
      catalogItemCount,
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