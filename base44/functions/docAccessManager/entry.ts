import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

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

function getExpiryTimestamp() {
  const now = new Date();
  const edmontonNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Edmonton' }));
  const tomorrow = new Date(edmontonNow);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  const offsetMs = now.getTime() - edmontonNow.getTime();
  return new Date(tomorrow.getTime() - offsetMs).toISOString();
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const { action } = body;

    // ── createRequest ───────────────────────────────────────────────────────
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

        const existing = await base44.asServiceRole.entities.DocAccessRequest.list({
          filter: { requester_id: requesterId, driver_id: driverId, status: 'pending' },
          limit: 1
        });

        if (existing && existing.length > 0) {
          const updated = await base44.asServiceRole.entities.DocAccessRequest.update(existing[0].id, {
            requested_doc_types,
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
            requested_doc_types,
            requested_at: requestedAt,
            expires_at: expiresAt,
          });
          createdRequests.push(created);
        }

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

        await sendPush(base44, driverId,
          'Document Access Request',
          `${requesterName} requested to view your ${requested_doc_types.map(t => t.replace('_', ' ')).join(', ')}`,
          '/Documents'
        );
      }

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

    // ── approve ─────────────────────────────────────────────────────────────
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

      const pushTitle = 'Document Access Approved';
      const pushBody = `${approverName} approved your request to view ${reqRecord.driver_name || 'driver'} documents.`;
      await sendPush(base44, reqRecord.requester_id, pushTitle, pushBody, '/Documents');

      if (isApproverDriver) {
        const adminIds = await getAllAdminIds(base44);
        for (const adminId of adminIds) {
          if (adminId !== approverId) {
            await sendPush(base44, adminId, pushTitle,
              `${approverName} (driver) approved ${reqRecord.requester_name}'s request.`,
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

    // ── deny ─────────────────────────────────────────────────────────────────
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

      await sendPush(base44, reqRecord.requester_id, 'Document Access Denied',
        `${denierName} denied your request to view ${reqRecord.driver_name || 'driver'} documents.`,
        '/Documents'
      );

      return Response.json({ success: true, request_id });
    }

    // ── revoke ───────────────────────────────────────────────────────────────
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
        doc_ids: [],
        viewed_at: now,
        user_agent: 'doc-access-manager',
      });

      return Response.json({ success: true, request_id });
    }

    // ── uploadDocumentBase64 ─────────────────────────────────────────────────
    if (action === 'uploadDocumentBase64') {
      const { document_type, document_scope, driver_id, driver_name, store_id, store_name,
              file_data_url, file_name, file_size, mime_type, expiry_date } = body;

      if (!document_type || !file_data_url) {
        return Response.json({ error: 'document_type and file_data_url are required' }, { status: 400 });
      }

      const matches = file_data_url.match(/^data:([^;]+);base64,(.+)$/);
      if (!matches) return Response.json({ error: 'Invalid file_data_url format' }, { status: 400 });
      const mimeType = matches[1] || mime_type || 'image/jpeg';
      const base64Str = matches[2];
      const byteChars = atob(base64Str);
      const byteNums = new Uint8Array(byteChars.length);
      for (let i = 0; i < byteChars.length; i++) byteNums[i] = byteChars.charCodeAt(i);
      const blob = new Blob([byteNums], { type: mimeType });
      const fileObj = new File([blob], file_name || `doc_${Date.now()}.jpg`, { type: mimeType });

      let fileUri;
      try {
        const uploadResult = await base44.asServiceRole.integrations.Core.UploadFile({ file: fileObj });
        fileUri = uploadResult?.file_url || uploadResult?.data?.file_url || uploadResult?.uri || uploadResult?.file_uri;
        if (!fileUri) throw new Error('No URL returned from upload');
      } catch (uploadErr) {
        console.error('[docAccessManager] UploadFile failed:', uploadErr?.message || uploadErr);
        return Response.json({ error: 'File upload failed: ' + (uploadErr?.message || 'server error') }, { status: 502 });
      }

      const uploaderId = user.id;
      const uploaderName = user.full_name || user.email || 'Unknown';
      const { existing_doc_id } = body;

      let docRecord;
      if (existing_doc_id) {
        // Update existing document record (re-crop / rotate replace)
        docRecord = await base44.asServiceRole.entities.DriverDocument.update(existing_doc_id, {
          file_uri: fileUri,
          file_size: file_size || byteNums.length,
          mime_type: mimeType,
          uploaded_at: new Date().toISOString(),
          uploaded_by: uploaderId,
          uploaded_by_name: uploaderName,
        });
      } else {
        docRecord = await base44.asServiceRole.entities.DriverDocument.create({
          document_type,
          document_scope: document_scope || 'driver',
          driver_id: driver_id || null,
          driver_name: driver_name || null,
          store_id: store_id || null,
          store_name: store_name || null,
          file_uri: fileUri,
          file_size: file_size || byteNums.length,
          mime_type: mimeType,
          uploaded_at: new Date().toISOString(),
          uploaded_by: uploaderId,
          uploaded_by_name: uploaderName,
          document_expiry_date: expiry_date || null,
        });
      }

      await base44.asServiceRole.entities.DocAuditLog.create({
        viewer_id: uploaderId,
        viewer_name: uploaderName,
        action: 'uploaded',
        driver_id: driver_id || null,
        driver_name: driver_name || null,
        doc_ids: [docRecord.id],
        viewed_at: new Date().toISOString(),
        user_agent: 'doc-access-manager-base64',
      });

      return Response.json({ success: true, document: docRecord });
    }

    // ── deleteDocument ───────────────────────────────────────────────────────
    if (action === 'deleteDocument') {
      const { doc_id } = body;
      if (!doc_id) return Response.json({ error: 'doc_id is required' }, { status: 400 });

      const doc = await base44.asServiceRole.entities.DriverDocument.get(doc_id);
      if (!doc) return Response.json({ error: 'Document not found' }, { status: 404 });

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
});