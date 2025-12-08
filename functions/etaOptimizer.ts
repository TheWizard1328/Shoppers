import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

// Utility: Convert time string to minutes
const timeToMinutes = (timeStr) => {
  if (!timeStr) return 0;
  const [hours, minutes] = timeStr.split(':').map(Number);
  return hours * 60 + minutes;
};

// Utility: Convert minutes to time string
const minutesToTime = (minutes) => {
  const h = Math.floor(minutes / 60) % 24;
  const m = Math.floor(minutes % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

// Utility: Calculate distance between two coordinates (Haversine formula)
const calculateDistance = (lat1, lon1, lat2, lon2) => {
  const R = 6371; // Earth's radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

// Utility: Estimate travel time with basic traffic factor
const estimateTravelTimeWithTraffic = (distanceKm, currentTimeStr) => {
  const avgSpeedKmh = 50;
  const baseTime = (distanceKm / avgSpeedKmh) * 60;
  
  // Apply basic traffic multiplier based on time of day
  const currentMinutes = timeToMinutes(currentTimeStr);
  let trafficMultiplier = 1.0;
  
  // Morning rush: 7-9 AM
  if (currentMinutes >= 420 && currentMinutes < 540) {
    trafficMultiplier = 1.3;
  }
  // Evening rush: 4-6 PM
  else if (currentMinutes >= 960 && currentMinutes < 1080) {
    trafficMultiplier = 1.3;
  }
  // Lunch time: 12-1 PM
  else if (currentMinutes >= 720 && currentMinutes < 780) {
    trafficMultiplier = 1.15;
  }
  
  return Math.ceil(baseTime * trafficMultiplier);
};

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
    
    const body = await req.json();
    const { driverId, deliveryDate, currentLocation } = body;
    
    if (!driverId || !deliveryDate || !currentLocation) {
      return Response.json({ 
        error: 'Missing required parameters: driverId, deliveryDate, and currentLocation' 
      }, { status: 400 });
    }
    
    console.log('');
    console.log('⏱️ [ETA OPTIMIZER] Starting ETA update');
    console.log(`   Driver: ${driverId}`);
    console.log(`   Date: ${deliveryDate}`);
    console.log(`   Location: ${currentLocation.latitude.toFixed(4)}, ${currentLocation.longitude.toFixed(4)}`);
    
    // Fetch all incomplete deliveries for this driver and date (ordered by stop_order)
    const incompleteStatuses = ['pending', 'Ready For Pickup', 'in_transit', 'en_route'];
    const allDeliveries = await base44.asServiceRole.entities.Delivery.filter({
      driver_id: driverId,
      delivery_date: deliveryDate,
      status: { $in: incompleteStatuses }
    }, 'stop_order', 1000);
    
    console.log(`📦 Fetched ${allDeliveries.length} incomplete deliveries`);
    
    if (allDeliveries.length === 0) {
      console.log('✅ No incomplete deliveries to update');
      return Response.json({ 
        success: true, 
        message: 'No incomplete deliveries',
        updatedCount: 0
      });
    }
    
    // Sort by stop_order to ensure we process in route sequence
    const sortedDeliveries = allDeliveries.sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
    
    // Calculate ETAs based on current location and route sequence
    let currentMinutes = timeToMinutes(new Date().toTimeString().slice(0, 5));
    const currentTimeStr = minutesToTime(currentMinutes);
    let currentLoc = currentLocation;
    
    const updates = [];
    
    console.log('🔄 Recalculating ETAs...');
    
    for (let i = 0; i < sortedDeliveries.length; i++) {
      const delivery = sortedDeliveries[i];
      
      // Calculate distance and travel time to this stop
      const distance = calculateDistance(
        currentLoc.latitude,
        currentLoc.longitude,
        delivery.latitude,
        delivery.longitude
      );
      
      const travelTime = estimateTravelTimeWithTraffic(distance, minutesToTime(currentMinutes));
      currentMinutes += travelTime;
      
      const newETA = minutesToTime(currentMinutes);
      
      // Only update if ETA has changed significantly (more than 2 minutes)
      const oldETA = delivery.delivery_time_eta;
      const oldMinutes = oldETA ? timeToMinutes(oldETA) : 0;
      const diff = Math.abs(currentMinutes - oldMinutes);
      
      if (diff >= 2 || !oldETA) {
        updates.push({
          id: delivery.id,
          delivery_time_eta: newETA,
          oldETA,
          newETA
        });
        
        console.log(`   ${i + 1}. ${delivery.patient_name || 'Store Pickup'}: ${oldETA || 'N/A'} → ${newETA} (${diff}m change)`);
      }
      
      // Add service time and move to next location
      currentMinutes += (delivery.extra_time || 5);
      currentLoc = {
        latitude: delivery.latitude,
        longitude: delivery.longitude
      };
    }
    
    // Batch update all ETAs
    if (updates.length > 0) {
      console.log('');
      console.log(`💾 Updating ${updates.length} ETAs...`);
      
      for (const update of updates) {
        await base44.asServiceRole.entities.Delivery.update(update.id, {
          delivery_time_eta: update.delivery_time_eta
        });
      }
      
      console.log('✅ ETAs updated');
    } else {
      console.log('');
      console.log('✅ No significant ETA changes detected');
    }
    
    console.log('');
    console.log('⏱️ [ETA OPTIMIZER] Update complete');
    
    return Response.json({
      success: true,
      updatedCount: updates.length,
      updates: updates.map(u => ({
        id: u.id,
        oldETA: u.oldETA,
        newETA: u.newETA
      }))
    });
    
  } catch (error) {
    console.error('❌ [ETA OPTIMIZER] Error:', error);
    return Response.json({ 
      error: error.message || 'Internal server error'
    }, { status: 500 });
  }
});