import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

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
    return Response.json({ error: error?.message || 'Internal Server Error' }, { status: 500 });
  }
});

    const responseText = await response.text();
    let responseBody = null;
    try {
      responseBody = responseText ? JSON.parse(responseText) : null;
    } catch {
      responseBody = responseText || null;
    }

    if (!response.ok) {
      console.warn('[squareDeleteCodItem] Square delete non-fatal error:', response.status, responseBody);
      return { attempted: true, ok: false, status: response.status, body: responseBody };
    }

    return { attempted: true, ok: true, body: responseBody };
  } catch (error) {
    console.warn('[squareDeleteCodItem] Square delete request failed (non-fatal):', error?.message || error);
    return { attempted: true, ok: false, error: error?.message || String(error) };
  }
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { deliveryId, transactionId, catalogObjectId, reason } = await req.json().catch(() => ({}));

    if (!deliveryId && !transactionId && !catalogObjectId) {
      return Response.json({ error: 'Missing required field: deliveryId, transactionId, or catalogObjectId' }, { status: 400 });
    }

    const accessToken = Deno.env.get('SQUARE_ACCESS_TOKEN');
    if (!accessToken) {
      return Response.json({ error: 'Square credentials not configured' }, { status: 500 });
    }

    let primaryTransaction = null;
    const relatedTransactions = [];

    if (transactionId) {
      const transaction = await base44.asServiceRole.entities.SquareTransaction.get(transactionId).catch(() => null);
      if (transaction) {
        primaryTransaction = transaction;
        relatedTransactions.push(transaction);
      }
    }

    if (deliveryId) {
      const deliveryTransactions = await base44.asServiceRole.entities.SquareTransaction.filter(
        { delivery_id: deliveryId },
        '-updated_date',
        50
      ).catch(() => []);

      for (const transaction of deliveryTransactions || []) {
        if (!relatedTransactions.some((item) => item?.id === transaction?.id)) {
          relatedTransactions.push(transaction);
        }
      }

      if (!primaryTransaction && relatedTransactions.length > 0) {
        primaryTransaction = relatedTransactions[0];
      }
    }

    const catalogIdToDelete = catalogObjectId || primaryTransaction?.square_catalog_object_id || relatedTransactions[0]?.square_catalog_object_id || null;
    const squareDeleteResult = await safeDeleteSquareCatalogObject(catalogIdToDelete, accessToken);

    const newStatus = reason === 'failed' ? 'failed' : 'cancelled';
    await Promise.all(
      relatedTransactions.map((transaction) =>
        base44.asServiceRole.entities.SquareTransaction.update(transaction.id, {
          status: newStatus,
          raw_square_data: {
            ...(transaction.raw_square_data || {}),
            deleted_at: new Date().toISOString(),
            deleted_reason: reason || 'manual_delete',
          },
        }).catch((error) => {
          console.warn('[squareDeleteCodItem] Could not update transaction record:', error?.message || error);
          return null;
        })
      )
    );

    const catalogMatches = [];
    if (deliveryId) {
      const byDelivery = await base44.asServiceRole.entities.SquareCatalogItems.filter(
        { delivery_id: deliveryId },
        '-updated_date',
        50
      ).catch(() => []);
      catalogMatches.push(...(byDelivery || []));
    }
    if (catalogIdToDelete) {
      const byCatalog = await base44.asServiceRole.entities.SquareCatalogItems.filter(
        { square_catalog_object_id: catalogIdToDelete },
        '-updated_date',
        50
      ).catch(() => []);
      catalogMatches.push(...(byCatalog || []));
    }

    const uniqueCatalogMatches = Array.from(new Map(catalogMatches.filter(Boolean).map((item) => [item.id, item])).values());
    await Promise.all(
      uniqueCatalogMatches.map((item) =>
        base44.asServiceRole.entities.SquareCatalogItems.delete(item.id).catch((error) => {
          console.warn('[squareDeleteCodItem] Could not delete SquareCatalogItems record:', error?.message || error);
          return null;
        })
      )
    );

    return Response.json({
      success: true,
      deletedCatalogId: catalogIdToDelete,
      transactionCount: relatedTransactions.length,
      deletedCatalogRecordCount: uniqueCatalogMatches.length,
      squareDeleteResult,
      transactionStatus: relatedTransactions.length > 0 ? newStatus : 'deleted_from_square',
    });
  } catch (error) {
    console.error('Error deleting Square COD item:', error);
    return Response.json({ error: error?.message || 'Internal Server Error' }, { status: 500 });
  }
});