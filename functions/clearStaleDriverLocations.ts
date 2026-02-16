import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    
    // Get all AppUsers
    const appUsers = await base44.asServiceRole.entities.AppUser.list();
    
    const now = new Date();
    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);
    
    let clearedCount = 0;
    const updates = [];
    
    for (const appUser of appUsers) {
      if (!appUser.location_updated_at) continue;
      
      const lastUpdate = new Date(appUser.location_updated_at);
      
      // If location is older than 5 minutes, clear it
      if (lastUpdate < fiveMinutesAgo) {
        updates.push(
          base44.asServiceRole.entities.AppUser.update(appUser.id, {
            current_latitude: null,
            current_longitude: null,
            location_updated_at: null
          })
        );
        clearedCount++;
      }
    }
    
    // Execute all updates in parallel
    if (updates.length > 0) {
      await Promise.all(updates);
      console.log(`✅ Cleared ${clearedCount} stale driver locations (older than 5 minutes)`);
    }
    
    return Response.json({
      success: true,
      clearedCount,
      message: `Cleared ${clearedCount} stale driver locations`
    });
    
  } catch (error) {
    console.error('Error clearing stale driver locations:', error);
    return Response.json({ 
      success: false, 
      error: error.message 
    }, { status: 500 });
  }
});