import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const { doc_id, viewer_id, viewer_name } = body;

    if (!doc_id) return Response.json({ error: 'doc_id is required' }, { status: 400 });

    const doc = await base44.asServiceRole.entities.DriverDocument.get(doc_id);
    if (!doc) return Response.json({ error: 'Document not found' }, { status: 404 });

    // Check access: admin, the document's own driver, or a dispatcher with an active approved request
    const isAdmin = user.app_roles?.includes('admin');
    const isOwner = doc.driver_id === user.id;

    if (!isAdmin && !isOwner) {
      // Check if dispatcher has an active approved request for this driver
      const activeRequests = await base44.asServiceRole.entities.DocAccessRequest.filter(
        { requester_id: user.id, driver_id: doc.driver_id, status: 'approved' },
        '-approved_at', 10
      );
      const now = new Date();
      const hasAccess = (activeRequests || []).some(r => {
        if (r.expires_at && now > new Date(r.expires_at)) return false;
        if (r.first_viewed_at) {
          const expiry = new Date(new Date(r.first_viewed_at).getTime() + 30 * 60 * 1000);
          if (now > expiry) return false;
        }
        return true;
      });
      if (!hasAccess) return Response.json({ error: 'Access denied' }, { status: 403 });
    }

    // The file_uri stored is the public URL from UploadFile — return it directly
    let fileUrl = doc.file_uri;

    // If it's a private URI, create a signed URL
    if (doc.file_uri && (doc.file_uri.startsWith('base44-private://') || doc.file_uri.startsWith('private://'))) {
      try {
        const signed = await base44.asServiceRole.integrations.Core.CreateFileSignedUrl({
          file_uri: doc.file_uri,
          expires_in: 300
        });
        fileUrl = signed?.signed_url || signed?.url || doc.file_uri;
      } catch (e) {
        console.warn('Could not create signed URL:', e?.message || e);
      }
    }

    // Audit log
    try {
      await base44.asServiceRole.entities.DocAuditLog.create({
        viewer_id: user.id,
        viewer_name: user.full_name || user.email || 'Unknown',
        action: 'viewed',
        driver_id: doc.driver_id,
        driver_name: doc.driver_name,
        doc_ids: [doc_id],
        viewed_at: new Date().toISOString(),
        user_agent: req.headers.get('user-agent') || 'unknown',
      });
    } catch (_) {}

    return Response.json({
      success: true,
      file_url: fileUrl,
      document_type: doc.document_type,
      driver_name: doc.driver_name,
      driver_id: doc.driver_id,
      mime_type: doc.mime_type || 'image/jpeg',
    });
  } catch (error) {
    console.error('[serveDriverDoc] error:', error);
    return Response.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
});