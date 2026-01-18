import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { deliveryId, paymentMethod, driverId, patientId, storeId } = await req.json();

    if (!deliveryId || !paymentMethod) {
      return Response.json({ error: 'Missing required fields: deliveryId, paymentMethod' }, { status: 400 });
    }

    // Find the pending SquareTransaction for this delivery
    const transactions = await base44.asServiceRole.entities.SquareTransaction.filter({
      delivery_id: deliveryId,
      status: 'pending'
    });

    if (transactions.length === 0) {
      return Response.json({ error: 'No pending Square transaction found for this delivery' }, { status: 404 });
    }

    const transaction = transactions[0];

    // Update transaction with payment details
    await base44.asServiceRole.entities.SquareTransaction.update(transaction.id, {
      status: 'completed',
      payment_method: paymentMethod.toLowerCase(),
      driver_id: driverId || user.id,
      patient_id: patientId,
      store_id: storeId,
      raw_square_data: {
        ...transaction.raw_square_data,
        payment_recorded_at: new Date().toISOString(),
        payment_method: paymentMethod
      }
    });

    // Now delete the Square catalog item since payment is collected
    const accessToken = Deno.env.get('SQUARE_ACCESS_TOKEN');
    
    if (accessToken && transaction.square_catalog_object_id) {
      try {
        await fetch(`https://connect.squareup.com/v2/catalog/object/${transaction.square_catalog_object_id}`, {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Square-Version': '2024-01-18'
          }
        });
      } catch (deleteError) {
        console.error('Failed to delete Square catalog item:', deleteError);
        // Continue - the payment is still recorded
      }
    }

    return Response.json({
      success: true,
      transactionId: transaction.id,
      itemName: transaction.item_name,
      amount: transaction.amount,
      paymentMethod
    });

  } catch (error) {
    console.error('Error recording Square payment:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});