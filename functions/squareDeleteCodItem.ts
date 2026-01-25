import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

const SQUARE_BASE_URL = 'https://connect.squareup.com/v2';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { deliveryId, transactionId, catalogObjectId, reason } = await req.json();

    if (!deliveryId && !transactionId && !catalogObjectId) {
      return Response.json({ error: 'Missing required field: deliveryId, transactionId, or catalogObjectId' }, { status: 400 });
    }

    const accessToken = Deno.env.get('SQUARE_ACCESS_TOKEN');

    if (!accessToken) {
      return Response.json({ error: 'Square credentials not configured' }, { status: 500 });
    }

    let transaction = null;
    let catalogIdToDelete = catalogObjectId;

    // Find the transaction by various methods
    if (transactionId) {
      // Direct transaction ID lookup
      const transactions = await base44.asServiceRole.entities.SquareTransaction.filter({ id: transactionId });
      transaction = transactions[0];
      catalogIdToDelete = transaction?.square_catalog_object_id || catalogObjectId;
    } else if (deliveryId) {
      // Find by delivery ID (any status, not just pending)
      const transactions = await base44.asServiceRole.entities.SquareTransaction.filter({ delivery_id: deliveryId });
      transaction = transactions[0];
      catalogIdToDelete = transaction?.square_catalog_object_id || catalogObjectId;
    }
    if (catalogIdToDelete) {
      // Delete the catalog item from Square
      const deleteResponse = await fetch(`${SQUARE_BASE_URL}/catalog/object/${catalogIdToDelete}`, {
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

    // Update our transaction record if we have one
    if (transaction) {
      const newStatus = reason === 'failed' ? 'failed' : 'cancelled';
      await base44.asServiceRole.entities.SquareTransaction.update(transaction.id, {
        status: newStatus,
        raw_square_data: {
          ...(transaction.raw_square_data || {}),
          deleted_at: new Date().toISOString(),
          deleted_reason: reason || 'manual_delete'
        }
      });
    }

    return Response.json({
      success: true,
      deletedCatalogId: catalogIdToDelete,
      transactionStatus: transaction ? 'cancelled' : 'deleted_from_square'
    });

  } catch (error) {
    console.error('Error deleting Square COD item:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});