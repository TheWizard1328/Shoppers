// Redeployed on 2026-03-28
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    
    console.log('🧹 [DailyCleanup] Starting daily patient cleanup task...');
    
    // Call the main patient update function in daily cleanup mode
    const response = await base44.asServiceRole.functions.invoke('updatePatientsAfterRouteCompletion', {
      runDailyCleanup: true
    });
    
    const result = response?.data || response;
    console.log('✅ [DailyCleanup] Complete:', result);
    
    return Response.json(result);
  } catch (error) {
    console.error('❌ [DailyCleanup] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});