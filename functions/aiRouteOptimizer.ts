/**
 * AI-Powered Route Optimizer
 * 
 * This function performs intelligent route optimization using AI analysis.
 * It considers:
 * - Current traffic conditions
 * - Time windows
 * - Driver location
 * - New delivery assignments
 * - Historical delivery patterns
 */

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

// Get current time in Eastern Time
const getCurrentTimeET = () => {
  const now = new Date();
  return now.toLocaleString('en-US', { 
    timeZone: 'America/Toronto', 
    hour: '2-digit', 
    minute: '2-digit',
    hour12: false 
  });
};

// Calculate distance between two points (Haversine formula)
const calculateDistance = (lat1, lon1, lat2, lon2) => {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

// Convert time string to minutes
const timeToMinutes = (timeStr) => {
  if (!timeStr) return 0;
  const [hours, minutes] = timeStr.split(':').map(Number);
  return hours * 60 + minutes;
};

// Convert minutes to time string
const minutesToTime = (minutes) => {
  const hours = Math.floor(minutes / 60) % 24;
  const mins = minutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
};

// Estimate travel time with traffic consideration
const estimateTravelTimeWithTraffic = (distanceKm, timeOfDay, trafficConditions = 'normal') => {
  let baseSpeedKmH = 30;
  const hour = parseInt(timeOfDay?.split(':')[0] || '10');
  
  // Rush hour adjustments
  if ((hour >= 7 && hour <= 9) || (hour >= 16 && hour <= 18)) {
    baseSpeedKmH = 20;
  } else if (hour >= 22 || hour <= 6) {
    baseSpeedKmH = 40;
  }
  
  // Traffic condition multipliers
  const trafficMultipliers = {
    'light': 1.2,
    'normal': 1.0,
    'moderate': 0.8,
    'heavy': 0.6,
    'severe': 0.4
  };
  
  const multiplier = trafficMultipliers[trafficConditions] || 1.0;
  const effectiveSpeed = baseSpeedKmH * multiplier;
  
  return Math.round((distanceKm / effectiveSpeed) * 60);
};

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    
    const user = await base44.auth.me();
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
    
    const body = await req.json();
    const { 
      driverId, 
      deliveryDate, 
      currentLocation,
      trigger = 'manual', // 'on_duty', 'delivery_complete', 'manual', 'new_assignment'
      completedDeliveryId,
      enableAIAnalysis = true
    } = body;
    
    if (!driverId || !deliveryDate) {
      return Response.json({ 
        error: 'Missing required parameters: driverId and deliveryDate' 
      }, { status: 400 });
    }
    
    console.log('');
    console.log('═══════════════════════════════════════════════');
    console.log('🤖 [AI Route Optimizer] Starting intelligent optimization');
    console.log('═══════════════════════════════════════════════');
    console.log(`📅 Date: ${deliveryDate}`);
    console.log(`🚗 Driver ID: ${driverId}`);
    console.log(`🎯 Trigger: ${trigger}`);
    console.log(`📍 Current Location: ${currentLocation ? `[${currentLocation.latitude}, ${currentLocation.longitude}]` : 'Not provided'}`);
    
    // Fetch all necessary data
    const [deliveries, patients, stores, appUsers] = await Promise.all([
      base44.asServiceRole.entities.Delivery.filter({
        delivery_date: deliveryDate,
        driver_id: driverId
      }),
      base44.asServiceRole.entities.Patient.list(),
      base44.asServiceRole.entities.Store.list(),
      base44.asServiceRole.entities.AppUser.filter({ user_id: driverId })
    ]);
    
    console.log(`✅ Fetched ${deliveries.length} deliveries, ${patients.length} patients`);
    
    const driverAppUser = appUsers[0];
    const driverName = driverAppUser?.user_name || 'Driver';
    
    // Categorize deliveries
    const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
    const incompleteDeliveries = deliveries.filter(d => d && !finishedStatuses.includes(d.status));
    const completedDeliveries = deliveries.filter(d => d && finishedStatuses.includes(d.status));
    
    console.log(`📊 Incomplete: ${incompleteDeliveries.length}, Completed: ${completedDeliveries.length}`);
    
    if (incompleteDeliveries.length === 0) {
      console.log('✅ All deliveries complete - no optimization needed');
      return Response.json({
        success: true,
        message: 'Route complete - no optimization needed',
        routeComplete: true,
        notification: {
          type: 'route_complete',
          title: 'Route Complete! 🎉',
          message: `Congratulations! All ${completedDeliveries.length} stops completed.`
        }
      });
    }
    
    // Determine driver's current location
    let startLocation = null;
    if (currentLocation?.latitude && currentLocation?.longitude) {
      startLocation = currentLocation;
    } else if (driverAppUser?.current_latitude && driverAppUser?.current_longitude) {
      const locationAge = driverAppUser.location_updated_at 
        ? Date.now() - new Date(driverAppUser.location_updated_at).getTime()
        : Infinity;
      if (locationAge < 10 * 60 * 1000) {
        startLocation = { latitude: driverAppUser.current_latitude, longitude: driverAppUser.current_longitude };
      }
    }
    
    // Enrich deliveries with coordinates
    const enrichedDeliveries = incompleteDeliveries.map(delivery => {
      const enriched = { ...delivery };
      if (delivery.patient_id) {
        const patient = patients.find(p => p?.id === delivery.patient_id);
        if (patient?.latitude && patient?.longitude) {
          enriched.latitude = patient.latitude;
          enriched.longitude = patient.longitude;
          enriched.patientName = patient.full_name;
        }
      } else {
        const store = stores.find(s => s?.id === delivery.store_id);
        if (store?.latitude && store?.longitude) {
          enriched.latitude = store.latitude;
          enriched.longitude = store.longitude;
          enriched.patientName = `${store.name} Pickup`;
        }
      }
      return enriched;
    }).filter(d => d.latitude && d.longitude);
    
    // AI Analysis Phase
    let aiSuggestions = null;
    let trafficConditions = 'normal';
    
    if (enableAIAnalysis && enrichedDeliveries.length > 1) {
      console.log('');
      console.log('🧠 [AI Analysis] Analyzing route with AI...');
      
      try {
        const currentTime = getCurrentTimeET();
        const hour = parseInt(currentTime.split(':')[0]);
        
        // Build context for AI
        const routeContext = {
          driverName,
          currentTime,
          totalStops: enrichedDeliveries.length,
          deliveries: enrichedDeliveries.map(d => ({
            name: d.patientName,
            timeWindow: d.time_window_start && d.time_window_end 
              ? `${d.time_window_start}-${d.time_window_end}` 
              : 'flexible',
            status: d.status,
            hasCOD: (d.cod_total_amount_required || 0) > 0,
            isPickup: !d.patient_id
          })),
          isRushHour: (hour >= 7 && hour <= 9) || (hour >= 16 && hour <= 18),
          dayOfWeek: new Date(deliveryDate).toLocaleDateString('en-US', { weekday: 'long' })
        };
        
        const aiPrompt = `You are a delivery route optimization assistant. Analyze this route and provide brief, actionable suggestions.

Route Context:
- Driver: ${routeContext.driverName}
- Current time: ${routeContext.currentTime}
- Day: ${routeContext.dayOfWeek}
- Total stops remaining: ${routeContext.totalStops}
- Rush hour: ${routeContext.isRushHour ? 'Yes' : 'No'}

Stops:
${routeContext.deliveries.map((d, i) => `${i+1}. ${d.name} (${d.timeWindow}) - ${d.status}${d.hasCOD ? ' [COD]' : ''}${d.isPickup ? ' [PICKUP]' : ''}`).join('\n')}

Provide:
1. Traffic assessment (light/normal/moderate/heavy)
2. One key priority suggestion
3. Any time-sensitive alerts`;

        const aiResponse = await base44.asServiceRole.integrations.Core.InvokeLLM({
          prompt: aiPrompt,
          response_json_schema: {
            type: 'object',
            properties: {
              trafficAssessment: { 
                type: 'string', 
                enum: ['light', 'normal', 'moderate', 'heavy', 'severe'] 
              },
              prioritySuggestion: { type: 'string' },
              alerts: { 
                type: 'array', 
                items: { type: 'string' } 
              },
              recommendedFirstStop: { type: 'string' },
              estimatedCompletionTime: { type: 'string' }
            }
          }
        });
        
        if (aiResponse) {
          aiSuggestions = aiResponse;
          trafficConditions = aiResponse.trafficAssessment || 'normal';
          console.log(`   ✅ AI Analysis complete - Traffic: ${trafficConditions}`);
          console.log(`   💡 Suggestion: ${aiResponse.prioritySuggestion}`);
        }
      } catch (aiError) {
        console.warn('   ⚠️ AI analysis failed:', aiError.message);
      }
    }
    
    // Optimize route with traffic-aware timing
    console.log('');
    console.log('🔄 [Optimization] Calculating optimal route...');
    
    const currentTimeStr = getCurrentTimeET();
    let currentMinutes = timeToMinutes(currentTimeStr);
    let currentLoc = startLocation || { latitude: enrichedDeliveries[0].latitude, longitude: enrichedDeliveries[0].longitude };
    
    // Sort by priority: in_transit first, then by time window urgency
    const optimizedRoute = [];
    const remaining = [...enrichedDeliveries];
    
    // First: Add any in_transit deliveries
    const inTransit = remaining.filter(d => d.status === 'in_transit');
    for (const delivery of inTransit) {
      const idx = remaining.findIndex(d => d.id === delivery.id);
      if (idx !== -1) remaining.splice(idx, 1);
      
      const distance = calculateDistance(
        currentLoc.latitude, currentLoc.longitude,
        delivery.latitude, delivery.longitude
      );
      const travelTime = estimateTravelTimeWithTraffic(distance, currentTimeStr, trafficConditions);
      currentMinutes += travelTime;
      
      delivery.calculatedETA = minutesToTime(currentMinutes);
      delivery.estimatedTravelTime = travelTime;
      
      currentMinutes += (delivery.extra_time || 5);
      currentLoc = { latitude: delivery.latitude, longitude: delivery.longitude };
      
      optimizedRoute.push(delivery);
    }
    
    // Then: Optimize remaining by time window and distance
    while (remaining.length > 0) {
      let bestIdx = 0;
      let bestScore = -Infinity;
      
      for (let i = 0; i < remaining.length; i++) {
        const stop = remaining[i];
        
        // Check PUID constraint for deliveries
        if (stop.patient_id && stop.puid) {
          const pickupNeeded = remaining.some(d => !d.patient_id && d.stop_id === stop.puid);
          if (pickupNeeded) continue;
        }
        
        const distance = calculateDistance(
          currentLoc.latitude, currentLoc.longitude,
          stop.latitude, stop.longitude
        );
        const travelTime = estimateTravelTimeWithTraffic(distance, currentTimeStr, trafficConditions);
        const arrivalTime = currentMinutes + travelTime;
        
        // Score based on time window urgency and distance
        let score = 100 - distance * 5;
        
        if (stop.time_window_start && stop.time_window_end) {
          const windowStart = timeToMinutes(stop.time_window_start);
          const windowEnd = timeToMinutes(stop.time_window_end);
          
          if (arrivalTime >= windowStart && arrivalTime <= windowEnd) {
            score += 200;
            if (windowEnd - arrivalTime < 60) score += 100; // Urgent
          } else if (arrivalTime > windowEnd) {
            score -= 300; // Late penalty
          }
        }
        
        // Pickups get lower priority (unless they block deliveries)
        if (!stop.patient_id) {
          score -= 50;
        }
        
        if (score > bestScore) {
          bestScore = score;
          bestIdx = i;
        }
      }
      
      const selected = remaining.splice(bestIdx, 1)[0];
      
      const distance = calculateDistance(
        currentLoc.latitude, currentLoc.longitude,
        selected.latitude, selected.longitude
      );
      const travelTime = estimateTravelTimeWithTraffic(distance, currentTimeStr, trafficConditions);
      currentMinutes += travelTime;
      
      selected.calculatedETA = minutesToTime(currentMinutes);
      selected.estimatedTravelTime = travelTime;
      
      currentMinutes += (selected.extra_time || 5);
      currentLoc = { latitude: selected.latitude, longitude: selected.longitude };
      
      optimizedRoute.push(selected);
    }
    
    // Update database with optimized route
    console.log('');
    console.log('💾 [Database] Updating delivery records...');
    
    // First reset all isNextDelivery flags
    for (const delivery of deliveries) {
      if (delivery.isNextDelivery) {
        await base44.asServiceRole.entities.Delivery.update(delivery.id, { isNextDelivery: false });
      }
    }
    
    // Update with new order and ETAs
    const baseStopOrder = completedDeliveries.length;
    const updates = [];
    
    for (let i = 0; i < optimizedRoute.length; i++) {
      const stop = optimizedRoute[i];
      const newStopOrder = baseStopOrder + i + 1;
      const isNextStop = i === 0;
      
      await base44.asServiceRole.entities.Delivery.update(stop.id, {
        stop_order: newStopOrder,
        isNextDelivery: isNextStop,
        delivery_time_eta: stop.calculatedETA
      });
      
      updates.push({
        id: stop.id,
        name: stop.patientName,
        stop_order: newStopOrder,
        eta: stop.calculatedETA,
        isNextDelivery: isNextStop
      });
      
      console.log(`   #${newStopOrder}: ${stop.patientName} - ETA: ${stop.calculatedETA}${isNextStop ? ' ← NEXT' : ''}`);
    }
    
    // Generate polyline for next stop
    let polylineGenerated = false;
    if (optimizedRoute.length > 0 && startLocation) {
      const nextStop = optimizedRoute[0];
      
      try {
        console.log('');
        console.log('🗺️ [Polyline] Generating route to next stop...');
        
        const directionsResponse = await base44.asServiceRole.functions.invoke('getGoogleDirections', {
          origin_lat: startLocation.latitude,
          origin_lon: startLocation.longitude,
          dest_lat: nextStop.latitude,
          dest_lon: nextStop.longitude
        });
        
        if (directionsResponse?.encoded_polyline) {
          const existingPolylines = await base44.asServiceRole.entities.DriverRoutePolyline.filter({
            driver_id: driverId,
            delivery_date: deliveryDate
          });
          
          const polylineData = {
            segment_origin_lat: startLocation.latitude,
            segment_origin_lon: startLocation.longitude,
            segment_dest_lat: nextStop.latitude,
            segment_dest_lon: nextStop.longitude,
            encoded_polyline: directionsResponse.encoded_polyline,
            estimated_distance_km: directionsResponse.distance_km,
            estimated_duration_seconds: directionsResponse.duration_seconds,
            last_generated_at: new Date().toISOString()
          };
          
          if (existingPolylines?.length > 0) {
            await base44.asServiceRole.entities.DriverRoutePolyline.update(existingPolylines[0].id, polylineData);
          } else {
            await base44.asServiceRole.entities.DriverRoutePolyline.create({
              driver_id: driverId,
              delivery_date: deliveryDate,
              ...polylineData
            });
          }
          
          polylineGenerated = true;
          console.log(`   ✅ Polyline generated: ${directionsResponse.distance_km?.toFixed(2)} km`);
        }
      } catch (polyError) {
        console.warn('   ⚠️ Polyline generation failed:', polyError.message);
      }
    }
    
    // Build notification
    const nextStop = optimizedRoute[0];
    let notification = null;
    
    if (trigger === 'on_duty') {
      notification = {
        type: 'route_optimized',
        title: 'Route Ready! 🚗',
        message: `${optimizedRoute.length} stops optimized. First stop: ${nextStop?.patientName || 'Unknown'} (ETA: ${nextStop?.calculatedETA || 'N/A'})`,
        aiSuggestion: aiSuggestions?.prioritySuggestion
      };
    } else if (trigger === 'delivery_complete') {
      notification = {
        type: 'next_stop',
        title: 'Next Stop Updated 📍',
        message: `${optimizedRoute.length} stops remaining. Next: ${nextStop?.patientName || 'Unknown'} (ETA: ${nextStop?.calculatedETA || 'N/A'})`,
        aiSuggestion: aiSuggestions?.prioritySuggestion
      };
    } else if (trigger === 'new_assignment') {
      notification = {
        type: 'route_updated',
        title: 'Route Updated! 🔄',
        message: `New deliveries added. ${optimizedRoute.length} stops total. Next: ${nextStop?.patientName || 'Unknown'}`,
        aiSuggestion: aiSuggestions?.prioritySuggestion
      };
    }
    
    // Add alerts if any
    if (aiSuggestions?.alerts?.length > 0) {
      notification.alerts = aiSuggestions.alerts;
    }
    
    console.log('');
    console.log('═══════════════════════════════════════════════');
    console.log('✅ [AI Route Optimizer] Complete!');
    console.log(`   Updated ${updates.length} stops`);
    console.log(`   Traffic: ${trafficConditions}`);
    console.log(`   Polyline: ${polylineGenerated ? 'Generated' : 'Skipped'}`);
    console.log('═══════════════════════════════════════════════');
    
    return Response.json({
      success: true,
      message: `Optimized route with ${updates.length} stops`,
      updates,
      trafficConditions,
      aiSuggestions,
      notification,
      polylineGenerated,
      estimatedCompletionTime: aiSuggestions?.estimatedCompletionTime || minutesToTime(currentMinutes)
    });
    
  } catch (error) {
    console.error('❌ [AI Route Optimizer] Error:', error);
    return Response.json({ 
      error: error.message,
      stack: error.stack 
    }, { status: 500 });
  }
});