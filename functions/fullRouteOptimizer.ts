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

// Utility: Estimate travel time (basic - 50 km/h average)
const estimateTravelTime = (distanceKm) => {
  const avgSpeedKmh = 50;
  return Math.ceil((distanceKm / avgSpeedKmh) * 60);
};

// Utility: Check if delivery is an interstore pickup
const isInterstorePickup = (delivery) => {
  const nameCheck = delivery.patient_name?.toLowerCase().includes('interstore pickup') || 
                    delivery.patient_name?.toLowerCase().includes('(isp)');
  const notesCheck = delivery.delivery_notes?.toLowerCase().includes('interstore pickup') || 
                     delivery.delivery_notes?.toLowerCase().includes('(isp)');
  return nameCheck || notesCheck;
};

// Utility: Check if a delivery can be placed at current time
const canPlaceAtTime = (delivery, currentMinutes) => {
  const twStart = delivery.time_window_start || delivery.delivery_time_start;
  const twEnd = delivery.time_window_end || delivery.delivery_time_end;
  
  if (!twStart || !twEnd) return true; // No time window = flexible
  
  const startMinutes = timeToMinutes(twStart);
  const endMinutes = timeToMinutes(twEnd);
  
  return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
};

// Utility: Find nearest delivery to current location
const findNearestDelivery = (currentLoc, deliveries) => {
  let nearest = null;
  let minDistance = Infinity;
  
  for (const delivery of deliveries) {
    const distance = calculateDistance(
      currentLoc.latitude,
      currentLoc.longitude,
      delivery.latitude,
      delivery.longitude
    );
    
    if (distance < minDistance) {
      minDistance = distance;
      nearest = delivery;
    }
  }
  
  return nearest;
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
    
    if (!driverId || !deliveryDate) {
      return Response.json({ 
        error: 'Missing required parameters: driverId and deliveryDate' 
      }, { status: 400 });
    }
    
    console.log('');
    console.log('═══════════════════════════════════════════════════');
    console.log('🔧 [FULL ROUTE OPTIMIZER] Starting optimization');
    console.log(`   Driver: ${driverId}`);
    console.log(`   Date: ${deliveryDate}`);
    console.log('═══════════════════════════════════════════════════');
    
    // Fetch all incomplete deliveries for this driver and date
    const incompleteStatuses = ['pending', 'Ready For Pickup', 'in_transit', 'en_route'];
    const allDeliveries = await base44.asServiceRole.entities.Delivery.filter({
      driver_id: driverId,
      delivery_date: deliveryDate,
      status: { $in: incompleteStatuses }
    });
    
    console.log(`📦 Fetched ${allDeliveries.length} incomplete deliveries`);
    
    if (allDeliveries.length === 0) {
      console.log('✅ No incomplete deliveries to optimize');
      return Response.json({ 
        success: true, 
        message: 'No incomplete deliveries',
        optimizedRoute: []
      });
    }
    
    // Fetch stores for pickup time windows
    const storeIds = [...new Set(allDeliveries.map(d => d.store_id).filter(Boolean))];
    const stores = await base44.asServiceRole.entities.Store.filter({
      id: { $in: storeIds }
    });
    const storeMap = new Map(stores.map(s => [s.id, s]));
    
    console.log(`🏪 Fetched ${stores.length} stores`);
    
    // Separate pickups from deliveries
    const pickups = allDeliveries.filter(d => !d.patient_id);
    const deliveries = allDeliveries.filter(d => d.patient_id);
    
    console.log(`   Pickups: ${pickups.length}`);
    console.log(`   Deliveries: ${deliveries.length}`);
    
    // RULE 1: Sort pickups by time windows
    console.log('');
    console.log('📋 RULE 1: Sorting pickups by time windows...');
    
    const sortedPickups = pickups.sort((a, b) => {
      const aStart = timeToMinutes(a.delivery_time_start || a.time_window_start || '00:00');
      const bStart = timeToMinutes(b.delivery_time_start || b.time_window_start || '00:00');
      return aStart - bStart;
    });
    
    console.log('   Sorted pickups:');
    sortedPickups.forEach((p, i) => {
      const store = storeMap.get(p.store_id);
      console.log(`   ${i + 1}. ${store?.name || 'Unknown Store'} - ${p.delivery_time_start || p.time_window_start}`);
    });
    
    // Build delivery groups by pickup (PUID)
    const deliveriesByPickup = new Map();
    const flexibleDeliveries = [];
    const interstorePickups = [];
    
    for (const delivery of deliveries) {
      if (isInterstorePickup(delivery)) {
        interstorePickups.push(delivery);
      } else if (delivery.puid) {
        if (!deliveriesByPickup.has(delivery.puid)) {
          deliveriesByPickup.set(delivery.puid, []);
        }
        deliveriesByPickup.get(delivery.puid).push(delivery);
      } else {
        flexibleDeliveries.push(delivery);
      }
    }
    
    console.log('');
    console.log('📊 Delivery categorization:');
    console.log(`   Interstore pickups: ${interstorePickups.length}`);
    console.log(`   Linked deliveries: ${deliveries.filter(d => d.puid).length}`);
    console.log(`   Flexible deliveries: ${flexibleDeliveries.length}`);
    
    // RULE 2: Build optimized route
    console.log('');
    console.log('🚀 RULE 2: Building optimized route...');
    
    const optimizedRoute = [];
    let currentMinutes = timeToMinutes(new Date().toTimeString().slice(0, 5));
    let currentLoc = currentLocation || {
      latitude: sortedPickups[0]?.latitude || 0,
      longitude: sortedPickups[0]?.longitude || 0
    };
    
    // Process each pickup in time window order
    for (let pickupIndex = 0; pickupIndex < sortedPickups.length; pickupIndex++) {
      const pickup = sortedPickups[pickupIndex];
      const store = storeMap.get(pickup.store_id);
      
      console.log('');
      console.log(`   ━━━ Processing Pickup #${pickupIndex + 1}: ${store?.name} ━━━`);
      
      // STEP 1: Place interstore pickups for this store BEFORE the store pickup
      const relatedInterstorePickups = interstorePickups.filter(d => 
        d.store_id === pickup.store_id && !optimizedRoute.some(r => r.id === d.id)
      );
      
      if (relatedInterstorePickups.length > 0) {
        console.log(`   🔄 Placing ${relatedInterstorePickups.length} interstore pickups BEFORE store pickup`);
        
        for (const isp of relatedInterstorePickups) {
          const distance = calculateDistance(
            currentLoc.latitude, currentLoc.longitude,
            isp.latitude, isp.longitude
          );
          const travelTime = estimateTravelTime(distance);
          currentMinutes += travelTime;
          
          isp.calculatedETA = minutesToTime(currentMinutes);
          isp.estimatedTravelTime = travelTime;
          currentMinutes += (isp.extra_time || 5);
          
          optimizedRoute.push(isp);
          currentLoc = { latitude: isp.latitude, longitude: isp.longitude };
          
          console.log(`      ✓ ${isp.patient_name} - ETA: ${isp.calculatedETA}`);
        }
      }
      
      // STEP 2: Place the pickup itself
      const distance = calculateDistance(
        currentLoc.latitude, currentLoc.longitude,
        pickup.latitude, pickup.longitude
      );
      const travelTime = estimateTravelTime(distance);
      currentMinutes += travelTime;
      
      pickup.calculatedETA = minutesToTime(currentMinutes);
      pickup.estimatedTravelTime = travelTime;
      currentMinutes += (pickup.extra_time || 5);
      
      optimizedRoute.push(pickup);
      currentLoc = { latitude: pickup.latitude, longitude: pickup.longitude };
      
      console.log(`   📍 PICKUP: ${store?.name} - ETA: ${pickup.calculatedETA}`);
      
      // STEP 3: Place linked deliveries for this pickup
      const linkedDeliveries = deliveriesByPickup.get(pickup.stop_id) || [];
      
      if (linkedDeliveries.length > 0) {
        console.log(`   📦 Placing ${linkedDeliveries.length} linked deliveries...`);
        
        // Sort linked deliveries by nearest first (greedy algorithm)
        const remainingLinked = [...linkedDeliveries];
        
        while (remainingLinked.length > 0) {
          const nearest = findNearestDelivery(currentLoc, remainingLinked);
          
          if (!nearest) break;
          
          const idx = remainingLinked.findIndex(d => d.id === nearest.id);
          remainingLinked.splice(idx, 1);
          
          const dist = calculateDistance(
            currentLoc.latitude, currentLoc.longitude,
            nearest.latitude, nearest.longitude
          );
          const travel = estimateTravelTime(dist);
          currentMinutes += travel;
          
          // RULE 3: Check time window
          if (!canPlaceAtTime(nearest, currentMinutes)) {
            console.log(`      ⚠️ ${nearest.patient_name} violates time window, deferring...`);
            continue; // Skip for now (could implement deferred queue)
          }
          
          nearest.calculatedETA = minutesToTime(currentMinutes);
          nearest.estimatedTravelTime = travel;
          currentMinutes += (nearest.extra_time || 5);
          
          optimizedRoute.push(nearest);
          currentLoc = { latitude: nearest.latitude, longitude: nearest.longitude };
          
          console.log(`      ✓ ${nearest.patient_name} - ETA: ${nearest.calculatedETA}`);
        }
      }
      
      // STEP 4: Place flexible deliveries that are on the way to next pickup
      if (pickupIndex < sortedPickups.length - 1 && flexibleDeliveries.length > 0) {
        const nextPickup = sortedPickups[pickupIndex + 1];
        
        // Find flexible deliveries that are roughly between current location and next pickup
        const onTheWay = flexibleDeliveries.filter(d => {
          if (optimizedRoute.some(r => r.id === d.id)) return false;
          
          const distToCurrent = calculateDistance(
            currentLoc.latitude, currentLoc.longitude,
            d.latitude, d.longitude
          );
          const distToNext = calculateDistance(
            d.latitude, d.longitude,
            nextPickup.latitude, nextPickup.longitude
          );
          const directDist = calculateDistance(
            currentLoc.latitude, currentLoc.longitude,
            nextPickup.latitude, nextPickup.longitude
          );
          
          // Only include if it doesn't add more than 50% extra distance
          return (distToCurrent + distToNext) <= (directDist * 1.5);
        });
        
        if (onTheWay.length > 0) {
          console.log(`   🔀 Placing ${onTheWay.length} flexible deliveries on the way...`);
          
          // Sort by nearest first
          const sortedFlexible = onTheWay.sort((a, b) => {
            const aDist = calculateDistance(currentLoc.latitude, currentLoc.longitude, a.latitude, a.longitude);
            const bDist = calculateDistance(currentLoc.latitude, currentLoc.longitude, b.latitude, b.longitude);
            return aDist - bDist;
          });
          
          for (const flex of sortedFlexible) {
            const dist = calculateDistance(
              currentLoc.latitude, currentLoc.longitude,
              flex.latitude, flex.longitude
            );
            const travel = estimateTravelTime(dist);
            currentMinutes += travel;
            
            if (!canPlaceAtTime(flex, currentMinutes)) {
              console.log(`      ⚠️ ${flex.patient_name} violates time window, skipping...`);
              continue;
            }
            
            flex.calculatedETA = minutesToTime(currentMinutes);
            flex.estimatedTravelTime = travel;
            currentMinutes += (flex.extra_time || 5);
            
            optimizedRoute.push(flex);
            currentLoc = { latitude: flex.latitude, longitude: flex.longitude };
            
            console.log(`      ✓ ${flex.patient_name} - ETA: ${flex.calculatedETA}`);
          }
        }
      }
    }
    
    // STEP 5: Add any remaining flexible deliveries at the end
    const remainingFlexible = flexibleDeliveries.filter(d => !optimizedRoute.some(r => r.id === d.id));
    
    if (remainingFlexible.length > 0) {
      console.log('');
      console.log(`📦 Placing ${remainingFlexible.length} remaining flexible deliveries...`);
      
      const remaining = [...remainingFlexible];
      
      while (remaining.length > 0) {
        const nearest = findNearestDelivery(currentLoc, remaining);
        
        if (!nearest) break;
        
        const idx = remaining.findIndex(d => d.id === nearest.id);
        remaining.splice(idx, 1);
        
        const dist = calculateDistance(
          currentLoc.latitude, currentLoc.longitude,
          nearest.latitude, nearest.longitude
        );
        const travel = estimateTravelTime(dist);
        currentMinutes += travel;
        
        nearest.calculatedETA = minutesToTime(currentMinutes);
        nearest.estimatedTravelTime = travel;
        currentMinutes += (nearest.extra_time || 5);
        
        optimizedRoute.push(nearest);
        currentLoc = { latitude: nearest.latitude, longitude: nearest.longitude };
        
        console.log(`   ✓ ${nearest.patient_name} - ETA: ${nearest.calculatedETA}`);
      }
    }
    
    console.log('');
    console.log('💾 Updating database...');
    
    // Update database with new stop_order and ETAs
    for (let i = 0; i < optimizedRoute.length; i++) {
      const delivery = optimizedRoute[i];
      
      await base44.asServiceRole.entities.Delivery.update(delivery.id, {
        stop_order: i + 1,
        isNextDelivery: i === 0,
        delivery_time_eta: delivery.calculatedETA
      });
    }
    
    console.log(`✅ Updated ${optimizedRoute.length} deliveries`);
    
    // Generate polyline for first leg (if Google Maps API available)
    let polyline = null;
    
    try {
      if (optimizedRoute.length > 0) {
        console.log('');
        console.log('🗺️ Generating route polyline...');
        
        const origin = currentLocation || {
          latitude: optimizedRoute[0].latitude,
          longitude: optimizedRoute[0].longitude
        };
        
        const destination = optimizedRoute[0];
        
        const directionsResult = await base44.functions.invoke('getGoogleDirections', {
          origin: { lat: origin.latitude, lng: origin.longitude },
          destination: { lat: destination.latitude, lng: destination.longitude }
        });
        
        if (directionsResult?.routes?.[0]?.overview_polyline?.points) {
          polyline = directionsResult.routes[0].overview_polyline.points;
          
          // Save to DriverRoutePolyline entity
          const existingPolylines = await base44.asServiceRole.entities.DriverRoutePolyline.filter({
            driver_id: driverId,
            delivery_date: deliveryDate
          });
          
          if (existingPolylines.length > 0) {
            await base44.asServiceRole.entities.DriverRoutePolyline.update(existingPolylines[0].id, {
              encoded_polyline: polyline,
              segment_origin_lat: origin.latitude,
              segment_origin_lon: origin.longitude,
              segment_dest_lat: destination.latitude,
              segment_dest_lon: destination.longitude,
              last_generated_at: new Date().toISOString()
            });
          } else {
            await base44.asServiceRole.entities.DriverRoutePolyline.create({
              driver_id: driverId,
              delivery_date: deliveryDate,
              encoded_polyline: polyline,
              segment_origin_lat: origin.latitude,
              segment_origin_lon: origin.longitude,
              segment_dest_lat: destination.latitude,
              segment_dest_lon: destination.longitude,
              last_generated_at: new Date().toISOString()
            });
          }
          
          console.log('✅ Polyline saved');
        }
      }
    } catch (polylineError) {
      console.warn('⚠️ Polyline generation failed:', polylineError.message);
    }
    
    console.log('');
    console.log('═══════════════════════════════════════════════════');
    console.log('✅ [FULL ROUTE OPTIMIZER] Optimization complete');
    console.log(`   Total stops optimized: ${optimizedRoute.length}`);
    console.log('═══════════════════════════════════════════════════');
    
    return Response.json({
      success: true,
      optimizedRoute: optimizedRoute.map((d, i) => ({
        id: d.id,
        stop_order: i + 1,
        patient_name: d.patient_name || 'Store Pickup',
        calculatedETA: d.calculatedETA,
        isPickup: !d.patient_id
      })),
      polyline
    });
    
  } catch (error) {
    console.error('❌ [FULL ROUTE OPTIMIZER] Error:', error);
    return Response.json({ 
      error: error.message || 'Internal server error'
    }, { status: 500 });
  }
});