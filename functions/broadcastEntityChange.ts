import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    
    // Verify user is authenticated
    const user = await base44.auth.me();
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const payload = await req.json();
    // Accept both 'entity_name' and 'entity' for compatibility
    const entity_name = payload.entity_name || payload.entity;
    const operation = payload.operation;
    const metadata = payload.metadata || payload.data || {};
    const timestamp = payload.timestamp || new Date().toISOString();

    console.log(`📡 [Broadcast] ${user.full_name} triggered ${operation} on ${entity_name} at ${timestamp}`);

    // Store broadcast event in a dedicated entity for polling
    await base44.asServiceRole.entities.SyncBroadcast.create({
      entity_name: entity_name,
      operation: operation,
      triggered_by: user.id,
      triggered_by_name: user.full_name,
      timestamp: timestamp,
      metadata: metadata || {}
    });

    console.log(`✅ [Broadcast] Event stored - other devices will pick it up on next poll`);

    return Response.json({ 
      success: true,
      message: 'Broadcast sent'
    });

  } catch (error) {
    console.error('❌ [Broadcast] Error:', error);
    return Response.json({ 
      error: error.message 
    }, { status: 500 });
  }
});