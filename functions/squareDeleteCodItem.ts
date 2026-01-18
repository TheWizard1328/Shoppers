import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

const SQUARE_BASE_URL = 'https://connect.squareup.com/v2';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { deliveryId, reason } = await req.json();

    if (!deliveryId) {
      return Response.json({ error: 'Missing required field: deliveryId' }, { status: 400 });
    }

    const accessToken = Deno.env.get('SQUARE_ACCESS_TOKEN');

    if (!accessToken) {
      return Response.json({ error: 'Square credentials not configured' }, { status: 500 });
    }

    // Find the SquareTransaction for this delivery
    const transactions = await base44.asServiceRole.entities.SquareTransaction.filter({
      delivery_id: deliveryId,
      status: 'pending'
    });

    if (transactions.length === 0) {
      // No pending Square item to delete
      return Response.json({ success: true, message: 'No pending Square item found' });
    }

    const transaction = transactions[0];
    const catalogObjectId = transaction.square_catalog_object_id;

    if (catalogObjectId) {
      // Delete the catalog item from Square
      const deleteResponse = await fetch(`${SQUARE_BASE_URL}/catalog/object/${catalogObjectId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Square-Version': '2024-01-18'
        }
      });

      if (!deleteResponse.ok) {
        const errorData = await deleteResponse.json();
        console.error('Square delete error:', errorData);
        // Continue to update our record even if Square delete fails
      }
    }

    // Update our transaction record
    const newStatus = reason === 'failed' ? 'failed' : 'completed';
    await base44.asServiceRole.entities.SquareTransaction.update(transaction.id, {
      status: newStatus,
      raw_square_data: {
        ...transaction.raw_square_data,
        deleted_at: new Date().toISOString(),
        deleted_reason: reason || 'completed'
      }
    });

    return Response.json({
      success: true,
      deletedCatalogId: catalogObjectId,
      transactionStatus: newStatus
    });

  } catch (error) {
    console.error('Error deleting Square COD item:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});