import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

export default async function serveDriverDoc(req: any) {
  try {
    // Parse request body based on whether it is a standard Request object or an object wrapper
    let body: any = {};
    let base44: any = null;

    if (req && typeof req.json === 'function') {
      // It is a standard Request (Deno.serve style)
      try {
        body = await req.json();
      } catch (_e) {
        body = {};
      }
      base44 = createClientFromRequest(req);
    } else {
      // It is a wrapped request structure
      body = req?.body || {};
      // In some environments, base44 is globally available
      base44 = (globalThis as any).base44;
    }

    const { doc_id, viewer_id, viewer_name } = body;
    
    if (!doc_id || !viewer_id) {
      const errorMsg = 'Missing required parameters';
      if (req && typeof req.json === 'function') {
        return Response.json({ error: errorMsg }, { status: 400 });
      }
      return { status: 400, body: { error: errorMsg } };
    }
    
    // Fetch the document record
    const doc = await base44.asServiceRole.entities.DriverDocument.get(doc_id);
    if (!doc) {
      const errorMsg = 'Document not found';
      if (req && typeof req.json === 'function') {
        return Response.json({ error: errorMsg }, { status: 404 });
      }
      return { status: 404, body: { error: errorMsg } };
    }
    
    // Generate watermark text
    const now = new Date();
    const watermarkText = `${viewer_name || 'Unknown'} • ${now.toISOString().split('T')[0]} ${now.toTimeString().split(' ')[0]} • CONFIDENTIAL`;
    
    // Create a signed URL for the private file
    // The file_uri is a private storage URI (e.g., 'base44-private://...')
    let fileUrl = doc.file_uri;
    
    // If it's a private base44 URI, try to create a signed URL
    if (doc.file_uri && doc.file_uri.startsWith('base44-private://')) {
      try {
        const signed = await base44.files.createSignedUrl({ uri: doc.file_uri, expiresIn: 300 });
        fileUrl = signed.url || signed.signed_url || signed;
      } catch (e) {
        console.warn('Could not create signed URL with base44.files, trying base44.asServiceRole.files:', e);
        try {
          const signed = await base44.asServiceRole.files.createSignedUrl({ uri: doc.file_uri, expiresIn: 300 });
          fileUrl = signed.url || signed.signed_url || signed;
        } catch (e2) {
          console.warn('Could not create signed URL with base44.asServiceRole.files:', e2);
        }
      }
    }
    
    const responsePayload = {
      success: true,
      file_url: fileUrl,
      document_type: doc.document_type,
      driver_name: doc.driver_name,
      driver_id: doc.driver_id,
      watermark_text: watermarkText,
      mime_type: doc.mime_type || 'image/jpeg'
    };

    if (req && typeof req.json === 'function') {
      return Response.json(responsePayload);
    }
    
    return {
      status: 200,
      body: responsePayload
    };
  } catch (error: any) {
    console.error('serveDriverDoc error:', error);
    if (req && typeof req.json === 'function') {
      return Response.json({ error: 'Internal server error' }, { status: 500 });
    }
    return { status: 500, body: { error: 'Internal server error' } };
  }
}
