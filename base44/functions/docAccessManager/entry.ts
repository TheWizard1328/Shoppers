import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

/**
 * docAccessManager — handles all document access request lifecycle operations:
 *   - createRequest: dispatcher requests to view driver docs (license, background_check)
 *   - approve: driver or admin approves a request → push to admins + requesting dispatcher
 *   - deny: driver or admin denies a request → push to requesting dispatcher
 *   - revoke: revoke an active request
 *
 * Push notification routing:
 *   - createRequest: push to the driver + all admins
 *   - approve (by driver): push to admins + requesting dispatcher
 *   - approve (by admin): push to the driver + requesting dispatcher
 *   - deny: push to requesting dispatcher
 */

async function sendPush(base44, userId, title, body, url) {
  try {
    await base44.asServiceRole.functions.invoke('sendPushNotification', {
      user_id: userId,
      title,
      body,
      url: url || '/',
      tag: 'doc-access',
      requireInteraction: false,
    });
  } catch (e) {
    console.warn(`[docAccessManager] Push to ${userId} failed:`, e?.message || e);
  }
}

async function getAllAdminIds(base44) {
  try {
    const users = await base44.asServiceRole.entities.User.list({ limit: 500 });
    return (users || []).filter(u => u?.app_roles?.includes('admin')).map(u => u.id);
  } catch (e) {
    console.warn('[docAccessManager] Failed to get admins:', e);
    return [];
  }
}

// Midnight the following day in Edmonton time
function getExpiryTimestamp() {
  const now = new Date();
  // Edmonton is UTC-6 (MDT) or UTC-7 (MST). We use a simple approach:
  // calculate midnight the following day in local device time.
  // The server may be UTC, so we use America/Edmonton explicitly.
  const edmontonNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Edmonton' }));
  const tomorrow = new Date(edmontonNow);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  // Convert back — the difference between UTC and Edmonton determines the offset
  const offsetMs = now.getTime() - edmontonNow.getTime();
  return new Date(tomorrow.getTime() - offsetMs).toISOString();
}

export default async function docAccessManager(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const { action } = body;

    if (action === 'createRequest') {
      const { driver_ids, driver_names, requested_doc_types } = body;
      if (!driver_ids || !Array.isArray(driver_ids) || driver_ids.length === 0) {
        return Response.json({ error: 'driver_ids array is required' }, { status: 400 });
      }
      if (!requested_doc_types || !Array.isArray(requested_doc_types) || requested_doc_types.length === 0) {
        return Response.json({ error: 'requested_doc_types array is required' }, { status: 400 });
      }

      const requesterId = user.id;
      const requesterName = user.full_name || user.email || 'Dispatcher';
      const expiresAt = getExpiryTimestamp();
      const requestedAt = new Date().toISOString();

      const createdRequests = [];

      for (let i = 0; i < driver_ids.length; i++) {
        const driverId = driver_ids[i];
        const driverName = driver_names?.[i] || '';

        // Check for existing pending request from this dispatcher for this driver
        const existing = await base44.asServiceRole.entities.DocAccessRequest.list({
          filter: { requester_id: requesterId, driver_id: driverId, status: 'pending' },
          limit: 1
        });

        if (existing && existing.length > 0) {
          // Update existing request
          const updated = await base44.asServiceRole.entities.DocAccessRequest.update(existing[0].id, {
            requested_doc_types: requested_doc_types,
            requested_at: requestedAt,
            expires_at: expiresAt,
          });
          createdRequests.push(updated);
        } else {
          const created = await base44.asServiceRole.entities.DocAccessRequest.create({
            requester_id: requesterId,
            requester_name: requesterName,
            driver_id: driverId,
            driver_name: driverName,
            status: 'pending',
            requested_doc_types: requested_doc_types,
            requested_at: requestedAt,
            expires_at: expiresAt,
          });
          createdRequests.push(created);
        }

        // Audit log
        await base44.asServiceRole.entities.DocAuditLog.create({
          viewer_id: requesterId,
          viewer_name: requesterName,
          action: 'requested',
          driver_id: driverId,
          driver_name: driverName,
          doc_ids: requested_doc_types,
          viewed_at: requestedAt,
          user_agent: 'doc-access-manager',
        });

        // Push notification to the driver
        await sendPush(base44, driverId,
          'Document Access Request',
          `${requesterName} requested to view your ${requested_doc_types.map(t => t.replace('_', ' ')).join(', ')}`,
          '/Documents'
        );
      }

      // Push notification to all admins
      const adminIds = await getAllAdminIds(base44);
      for (const adminId of adminIds) {
        if (adminId !== requesterId) {
          await sendPush(base44, adminId,
            'Document Access Request',
            `${requesterName} requested to view documents for ${driver_names?.join(', ') || `${driver_ids.length} driver(s)`}`,
            '/Documents'
          );
        }
      }

      return Response.json({ success: true, created_requests: createdRequests.length, requests: createdRequests });
    }

    if (action === 'approve') {
      const { request_id } = body;
      if (!request_id) return Response.json({ error: 'request_id is required' }, { status: 400 });

      const reqRecord = await base44.asServiceRole.entities.DocAccessRequest.get(request_id);
      if (!reqRecord) return Response.json({ error: 'Request not found' }, { status: 404 });
      if (reqRecord.status !== 'pending') return Response.json({ error: 'Request is not pending' }, { status: 400 });

      const approverId = user.id;
      const approverName = user.full_name || user.email || 'Unknown';
      const isApproverDriver = user.app_roles?.includes('driver') && reqRecord.driver_id === approverId;
      const isApproverAdmin = user.app_roles?.includes('admin');

      if (!isApproverDriver && !isApproverAdmin) {
        return Response.json({ error: 'Only the driver or an admin can approve this request' }, { status: 403 });
      }

      const now = new Date().toISOString();
      await base44.asServiceRole.entities.DocAccessRequest.update(request_id, {
        status: 'approved',
        approved_at: now,
        approved_by: approverId,
        approved_by_name: approverName,
      });

      // Audit log
      await base44.asServiceRole.entities.DocAuditLog.create({
        viewer_id: approverId,
        viewer_name: approverName,
        action: 'approved',
        driver_id: reqRecord.driver_id,
        driver_name: reqRecord.driver_name,
        doc_ids: reqRecord.requested_doc_types || [],
        viewed_at: now,
        user_agent: 'doc-access-manager',
      });

      // Push notifications
      // If approved by driver → push to admins + requesting dispatcher
      // If approved by admin → push to the driver + requesting dispatcher
      const pushTitle = 'Document Access Approved';
      const pushBody = `${approverName} approved your request to view ${reqRecord.driver_name || 'driver'} documents. Access expires at midnight.`;

      await sendPush(base44, reqRecord.requester_id, pushTitle, pushBody, '/Documents');

      if (isApproverDriver) {
        const adminIds = await getAllAdminIds(base44);
        for (const adminId of adminIds) {
          if (adminId !== approverId) {
            await sendPush(base44, adminId, pushTitle,
              `${approverName} (driver) approved ${reqRecord.requester_name}'s request to view ${reqRecord.driver_name}'s documents.`,
              '/Documents'
            );
          }
        }
      } else if (isApproverAdmin) {
        await sendPush(base44, reqRecord.driver_id, pushTitle,
          `${approverName} (admin) approved ${reqRecord.requester_name}'s request to view your documents.`,
          '/Documents'
        );
      }

      return Response.json({ success: true, request_id });
    }

    if (action === 'deny') {
      const { request_id } = body;
      if (!request_id) return Response.json({ error: 'request_id is required' }, { status: 400 });

      const reqRecord = await base44.asServiceRole.entities.DocAccessRequest.get(request_id);
      if (!reqRecord) return Response.json({ error: 'Request not found' }, { status: 404 });
      if (reqRecord.status !== 'pending') return Response.json({ error: 'Request is not pending' }, { status: 400 });

      const denierId = user.id;
      const denierName = user.full_name || user.email || 'Unknown';
      const isDenierDriver = user.app_roles?.includes('driver') && reqRecord.driver_id === denierId;
      const isDenierAdmin = user.app_roles?.includes('admin');

      if (!isDenierDriver && !isDenierAdmin) {
        return Response.json({ error: 'Only the driver or an admin can deny this request' }, { status: 403 });
      }

      const now = new Date().toISOString();
      await base44.asServiceRole.entities.DocAccessRequest.update(request_id, {
        status: 'denied',
        denied_at: now,
        denied_by: denierId,
      });

      await base44.asServiceRole.entities.DocAuditLog.create({
        viewer_id: denierId,
        viewer_name: denierName,
        action: 'denied',
        driver_id: reqRecord.driver_id,
        driver_name: reqRecord.driver_name,
        doc_ids: reqRecord.requested_doc_types || [],
        viewed_at: now,
        user_agent: 'doc-access-manager',
      });

      // Push to requesting dispatcher
      await sendPush(base44, reqRecord.requester_id, 'Document Access Denied',
        `${denierName} denied your request to view ${reqRecord.driver_name || 'driver'} documents.`,
        '/Documents'
      );

      return Response.json({ success: true, request_id });
    }

    if (action === 'revoke') {
      const { request_id } = body;
      if (!request_id) return Response.json({ error: 'request_id is required' }, { status: 400 });

      const reqRecord = await base44.asServiceRole.entities.DocAccessRequest.get(request_id);
      if (!reqRecord) return Response.json({ error: 'Request not found' }, { status: 404 });

      const now = new Date().toISOString();
      await base44.asServiceRole.entities.DocAccessRequest.update(request_id, {
        status: 'revoked',
        revoked_at: now,
        revoked_by: user.id,
      });

      await base44.asServiceRole.entities.DocAuditLog.create({
        viewer_id: user.id,
        viewer_name: user.full_name || user.email,
        action: 'revoked',
        driver_id: reqRecord.driver_id,
        driver_name: reqRecord.driver_name,
        viewed_at: now,
        user_agent: 'doc-access-manager',
      });

      return Response.json({ success: true, request_id });
    }

    if (action === 'uploadDocument') {
      const { document_type, document_scope, driver_id, driver_name, store_id, store_name, file_uri, file_size, mime_type, expiry_date } = body;

      if (!document_type || !file_uri) return Response.json({ error: 'document_type and file_uri are required' }, { status: 400 });
      if (document_scope === 'driver' && !driver_id) return Response.json({ error: 'driver_id is required for driver-scoped documents' }, { status: 400 });
      if (document_scope === 'store' && !store_id) return Response.json({ error: 'store_id is required for store-scoped documents' }, { status: 400 });

      const uploaderId = user.id;
      const uploaderName = user.full_name || user.email || 'Unknown';

      const docRecord = await base44.asServiceRole.entities.DriverDocument.create({
        document_type,
        document_scope: document_scope || 'driver',
        driver_id: driver_id || null,
        driver_name: driver_name || null,
        store_id: store_id || null,
        store_name: store_name || null,
        file_uri,
        file_size: file_size || null,
        mime_type: mime_type || 'image/jpeg',
        uploaded_at: new Date().toISOString(),
        uploaded_by: uploaderId,
        uploaded_by_name: uploaderName,
        document_expiry_date: expiry_date || null,
      });

      await base44.asServiceRole.entities.DocAuditLog.create({
        viewer_id: uploaderId,
        viewer_name: uploaderName,
        action: 'uploaded',
        driver_id: driver_id || null,
        driver_name: driver_name || null,
        doc_ids: [docRecord.id],
        viewed_at: new Date().toISOString(),
        user_agent: 'doc-access-manager',
      });

      return Response.json({ success: true, document: docRecord });
    }

    if (action === 'deleteDocument') {
      const { doc_id } = body;
      if (!doc_id) return Response.json({ error: 'doc_id is required' }, { status: 400 });

      const doc = await base44.asServiceRole.entities.DriverDocument.get(doc_id);
      if (!doc) return Response.json({ error: 'Document not found' }, { status: 404 });

      // Only the uploader, an admin, or the document's driver can delete
      const canDelete = user.app_roles?.includes('admin') || doc.uploaded_by === user.id ||
        (doc.document_scope === 'driver' && doc.driver_id === user.id);
      if (!canDelete) return Response.json({ error: 'Not authorized to delete this document' }, { status: 403 });

      await base44.asServiceRole.entities.DriverDocument.delete(doc_id);

      await base44.asServiceRole.entities.DocAuditLog.create({
        viewer_id: user.id,
        viewer_name: user.full_name || user.email,
        action: 'deleted',
        driver_id: doc.driver_id,
        driver_name: doc.driver_name,
        doc_ids: [doc_id],
        viewed_at: new Date().toISOString(),
        user_agent: 'doc-access-manager',
      });

      return Response.json({ success: true, doc_id });
    }

    return Response.json({ error: 'Unknown action' }, { status: 400 });
  } catch (error) {
    console.error('[docAccessManager] error:', error);
    return Response.json({ error: error.message || 'Unknown error' }, { status: 500 });
  }
}
