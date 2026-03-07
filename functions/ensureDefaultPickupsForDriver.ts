import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);

    // Read payload (supports both direct invocation and automation event payload)
    const body = await req.json().catch(() => ({}));

    // Detect if called by automation (entity event on Delivery create)
    const isAutomation = !!body?.event && !!body?.event?.entity_name;

    let driverId = body?.driverId || null;
    let deliveryDate = body?.deliveryDate || null;
    let storeId = body?.storeId || null;
    let ampmDeliveries = body?.ampmDeliveries || null;

    if (isAutomation) {
      const created = body?.data || null;
      driverId = driverId || created?.driver_id || null;
      deliveryDate = deliveryDate || created?.delivery_date || null;
      storeId = storeId || created?.store_id || null;
      ampmDeliveries = ampmDeliveries || created?.ampm_deliveries || null;

      // Skip if this IS a pickup (no patient_id means it's a pickup itself)
      if (created && !created.patient_id) {
        console.log('⏭️ [ensureDefaultPickups] Skipping — this delivery IS a pickup (no patient_id)');
        return Response.json({ ensured: 0, message: 'Skipped: delivery is a pickup' });
      }
    }

    if (!driverId || !deliveryDate) {
      return Response.json({ error: 'Missing driverId or deliveryDate' }, { status: 400 });
    }

    // Prefer user-scoped if available; otherwise, use service role (automations run server-side)
    let api = base44;
    try {
      const user = await base44.auth.me();
      if (!user) api = base44.asServiceRole;
    } catch {
      api = base44.asServiceRole;
    }

    // If we have a specific storeId (from automation or direct call), ensure pickup for just that store
    if (storeId) {
      console.log(`🔍 [ensureDefaultPickups] Ensuring pickup for store=${storeId}, date=${deliveryDate}, driver=${driverId}, ampm=${ampmDeliveries}`);

      const result = await api.functions.invoke('ensurePickupForDelivery', {
        storeId,
        deliveryDate,
        driverId,
        ampmDeliveries: ampmDeliveries || null,
        allowCreateIfMissing: true,
      }).then(r => r?.data || r).catch((e) => ({ error: String(e) }));

      const ensured = result && (result.pickupId || result.puid) ? 1 : 0;
      console.log(`✅ [ensureDefaultPickups] Result: ensured=${ensured}, isNew=${result?.isNew}, pickupId=${result?.pickupId}, deliveryStatus=${result?.deliveryStatus}`);

      // If the pickup was recently completed, update the new delivery's PUID and set status to in_transit
      if (isAutomation && result?.puid && result?.deliveryStatus === 'in_transit') {
        const deliveryId = body?.event?.entity_id;
        if (deliveryId) {
          try {
            await base44.asServiceRole.entities.Delivery.update(deliveryId, {
              puid: result.puid,
              status: 'in_transit'
            });
            console.log(`📦 [ensureDefaultPickups] Set delivery ${deliveryId} to in_transit with PUID=${result.puid} (pickup already completed)`);
          } catch (updateErr) {
            console.warn(`⚠️ [ensureDefaultPickups] Failed to update delivery status: ${updateErr.message}`);
          }
        }
      }
      // For en_route or new pickups, assign the PUID to the delivery
      else if (isAutomation && result?.puid) {
        const deliveryId = body?.event?.entity_id;
        if (deliveryId) {
          try {
            await base44.asServiceRole.entities.Delivery.update(deliveryId, {
              puid: result.puid
            });
            console.log(`📦 [ensureDefaultPickups] Assigned PUID=${result.puid} to delivery ${deliveryId}`);
          } catch (updateErr) {
            console.warn(`⚠️ [ensureDefaultPickups] Failed to assign PUID: ${updateErr.message}`);
          }
        }
      }

      return Response.json({ ensured, details: [result] });
    }

    // Fallback: no specific storeId — this shouldn't normally happen from automation
    // but kept for backwards compatibility with manual invocations
    console.log('⚠️ [ensureDefaultPickups] No storeId provided, skipping');
    return Response.json({ ensured: 0, message: 'No storeId provided' });

  } catch (error) {
    console.error('❌ [ensureDefaultPickups] Error:', error.message);
    return Response.json({ error: error.message || 'Failed to ensure default pickups' }, { status: 500 });
  }
});