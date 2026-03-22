import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    
    // CRITICAL: Use service role to bypass auth - this is a system task
    const now = new Date();
    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);
    
    console.log('🔍 [Heartbeat Monitor] Checking for inactive users...');
    console.log(`   Current time: ${now.toISOString()}`);
    console.log(`   5 minutes ago: ${fiveMinutesAgo.toISOString()}`);
    
    // Get all active AppUsers
    const allAppUsers = await base44.asServiceRole.entities.AppUser.filter({
      status: 'active'
    });
    
    console.log(`📊 [Heartbeat Monitor] Found ${allAppUsers.length} active users`);
    
    let updatedCount = 0;
    const updates = [];
    
    for (const appUser of allAppUsers) {
      // Skip if no location_updated_at (never tracked)
      if (!appUser.location_updated_at) {
        continue;
      }
      
      const lastActivity = new Date(appUser.location_updated_at);
      const inactiveMinutes = Math.floor((now - lastActivity) / 60000);
      
      // Skip if active within last 5 minutes
      if (lastActivity > fiveMinutesAgo) {
        continue;
      }
      
      // Skip if already off_duty
      if (appUser.driver_status === 'off_duty') {
        continue;
      }
      
      const roles = appUser.app_roles || [];
      const isDriver = roles.includes('driver');
      const isDispatcher = roles.includes('dispatcher');
      const isAdmin = roles.includes('admin');
      
      let shouldSetOffDuty = false;
      let reason = '';
      
      // RULE 1: Dispatcher - always set to off duty after 5 min
      if (isDispatcher) {
        shouldSetOffDuty = true;
        reason = 'Dispatcher inactive';
      }
      // RULE 2: Admin (not also a driver) - set to off duty after 5 min
      else if (isAdmin && !isDriver) {
        shouldSetOffDuty = true;
        reason = 'Admin inactive';
      }
      // RULE 3: Driver - only if no incomplete deliveries for today
      else if (isDriver) {
        // Check for incomplete deliveries today
        const todayStr = now.toISOString().split('T')[0];
        const todayDeliveries = await base44.asServiceRole.entities.Delivery.filter({
          driver_id: appUser.user_id,
          delivery_date: todayStr
        });
        
        const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned', 'pending'];
        const hasIncompleteDeliveries = todayDeliveries.some(d => 
          d && !finishedStatuses.includes(d.status)
        );
        
        if (!hasIncompleteDeliveries) {
          shouldSetOffDuty = true;
          reason = 'Driver inactive with no incomplete deliveries';
        } else {
          console.log(`⏭️ [${appUser.user_name}] Inactive ${inactiveMinutes}min but has ${todayDeliveries.filter(d => !finishedStatuses.includes(d.status)).length} incomplete deliveries - keeping status`);
        }
      }
      
      // Update to off_duty if conditions met
      if (shouldSetOffDuty) {
        console.log(`📴 [${appUser.user_name}] ${reason} - inactive for ${inactiveMinutes} minutes - setting to Off Duty`);
        
        await base44.asServiceRole.entities.AppUser.update(appUser.id, {
          driver_status: 'off_duty'
        });
        
        updatedCount++;
        updates.push({
          userId: appUser.user_id,
          userName: appUser.user_name,
          reason,
          inactiveMinutes
        });
      }
    }
    
    console.log(`✅ [Heartbeat Monitor] Complete - ${updatedCount} users set to Off Duty`);
    
    return Response.json({
      success: true,
      checked: allAppUsers.length,
      updated: updatedCount,
      updates
    });
    
  } catch (error) {
    console.error('❌ [Heartbeat Monitor] Error:', error);
    return Response.json({ 
      success: false, 
      error: error.message 
    }, { status: 500 });
  }
});