import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Forbidden' }, { status: 403 });

    // Fetch all cycling markers missing a delivery_id
    const allMarkers = await base44.asServiceRole.entities.Delivery.filter({ is_cycling_marker: true });
    const missing = (allMarkers || []).filter((d) => !d.delivery_id || !d.delivery_id.startsWith('BIK-'));

    if (missing.length === 0) {
      return Response.json({ updated: 0, message: 'All cycling markers already have BIK delivery_ids.' });
    }

    // Collect existing BIK IDs to avoid collisions
    const existingBikIds = new Set(
      (allMarkers || []).map((d) => d.delivery_id).filter((id) => id && id.startsWith('BIK-'))
    );

    const generateBikId = () => {
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
      const ts = Date.now().toString();
      const rand = Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
      return `BIK-${ts}-${rand}`;
    };

    const updates = [];
    for (const marker of missing) {
      let bikId = generateBikId();
      // Ensure uniqueness
      while (existingBikIds.has(bikId)) {
        bikId = generateBikId();
      }
      existingBikIds.add(bikId);
      updates.push(
        base44.asServiceRole.entities.Delivery.update(marker.id, { delivery_id: bikId })
          .then(() => ({ id: marker.id, delivery_id: bikId, success: true }))
          .catch((e) => ({ id: marker.id, success: false, error: e?.message }))
      );
    }

    const results = await Promise.all(updates);
    const succeeded = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    return Response.json({
      updated: succeeded,
      failed,
      total_missing: missing.length,
      results,
      message: `Backfilled ${succeeded} cycling markers with BIK delivery_ids.`
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});