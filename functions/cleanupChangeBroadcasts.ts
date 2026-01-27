import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    
    // ADMIN ONLY - verify user is admin
    const user = await base44.auth.me();
    if (user?.role !== 'admin') {
      return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
    }

    // Delete broadcasts older than 1 hour
    const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
    
    const oldBroadcasts = await base44.asServiceRole.entities.ChangeBroadcast.filter({
      created_date: { $lt: oneHourAgo }
    });

    let deletedCount = 0;
    if (oldBroadcasts && oldBroadcasts.length > 0) {
      for (const broadcast of oldBroadcasts) {
        await base44.asServiceRole.entities.ChangeBroadcast.delete(broadcast.id);
        deletedCount++;
      }
    }

    console.log(`🧹 [Cleanup] Deleted ${deletedCount} old ChangeBroadcast records`);
    
    return Response.json({ 
      success: true, 
      deletedCount,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ [Cleanup] Failed:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});