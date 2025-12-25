import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    
    // Verify user is authenticated
    const user = await base44.auth.me();
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { entity, operation, timestamp, data } = await req.json();

    console.log(`📡 [Broadcast] ${user.full_name} triggered ${operation} on ${entity} at ${timestamp}`);

    // Store broadcast event in a dedicated entity for polling
    await base44.asServiceRole.entities.SyncBroadcast.create({
      entity_name: entity,
      operation: operation,
      triggered_by: user.id,
      triggered_by_name: user.full_name,
      timestamp: timestamp,
      metadata: data || {}
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