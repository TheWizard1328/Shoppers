import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

export default async function expireDocAccessRequests(req: any) {
  try {
    let body: any = {};
    let base44: any = null;

    if (req && typeof req.json === 'function') {
      try { body = await req.json(); } catch (_e) { body = {}; }
      base44 = createClientFromRequest(req);
    } else {
      body = req?.body || {};
      base44 = (globalThis as any).base44;
    }

    const now = new Date();
    let expiredCount = 0;

    // Find all approved requests that should be expired
    const approvedRequests = await base44.asServiceRole.entities.DocAccessRequest.list({
      filter: { status: 'approved' },
      limit: 500
    });

    for (const req of (approvedRequests || [])) {
      let shouldExpire = false;

      // Check midnight expiry
      if (req.expires_at) {
        const expiresAt = new Date(req.expires_at);
        if (now > expiresAt) shouldExpire = true;
      }

      // Check 30-min from first view
      if (!shouldExpire && req.first_viewed_at) {
        const viewTime = new Date(req.first_viewed_at);
        const thirtyMinLater = new Date(viewTime.getTime() + 30 * 60 * 1000);
        if (now > thirtyMinLater) shouldExpire = true;
      }

      if (shouldExpire) {
        try {
          await base44.asServiceRole.entities.DocAccessRequest.update(req.id, {
            status: 'expired'
          });

          // Audit log
          await base44.asServiceRole.entities.DocAuditLog.create({
            viewer_id: req.requester_id,
            viewer_name: req.requester_name,
            action: 'expired',
            driver_id: req.driver_id,
            driver_name: req.driver_name,
            viewed_at: now.toISOString()
          });

          expiredCount++;
        } catch (e) {
          console.warn(`Failed to expire request ${req.id}:`, e);
        }
      }
    }

    const responsePayload = { success: true, expired_count: expiredCount, checked_at: now.toISOString() };
    
    if (req && typeof req.json === 'function') {
      return Response.json(responsePayload);
    }
    return responsePayload;
  } catch (error: any) {
    console.error('expireDocAccessRequests error:', error);
    if (req && typeof req.json === 'function') {
      return Response.json({ error: error.message }, { status: 500 });
    }
    return { error: error.message };
  }
}
