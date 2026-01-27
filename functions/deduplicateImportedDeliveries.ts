import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Only admins can run deduplication
    if (user.role !== 'admin') {
      return Response.json({ error: 'Admin access required' }, { status: 403 });
    }

    console.log(`🔍 [Dedup] Checking offline DB for duplicates...`);

    // CRITICAL: Only check offline DB where duplicates accumulate
    const offlineDB = Deno.env.get('OFFLINE_DB_MODULE');
    if (!offlineDB) {
      // Offline DB deduplication must be done on client side
      return Response.json({
        success: false,
        message: 'Offline DB deduplication must be run from client',
        totalDuplicatesDeleted: 0
      });
    }

    return Response.json({
      success: true,
      message: 'Use client-side offline DB deduplication',
      totalDuplicatesDeleted: 0
    });
  } catch (error) {
    console.error('❌ [Dedup] Error:', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
});