import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const payload = await req.json().catch(() => ({}));
    const response = await base44.functions.invoke('squareCodCore', {
      action: 'recordPayment',
      ...payload,
    });

    return Response.json(response?.data || response, { status: response?.status || 200 });
  } catch (error) {
    return Response.json({ error: error?.message || 'Internal Server Error' }, { status: 500 });
  }
});
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

    // Keep the Square catalog item active until the delivery is explicitly marked complete with Debit/Credit in the app.

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