// Redeployed on 2026-03-28
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

const isNotFoundError = (error) => error?.status === 404 || error?.response?.status === 404 || String(error?.message || '').toLowerCase().includes('not found');

/***
 * AI-Driven Delivery Prioritization.
 * 
 * Analyzes deliveries and suggests optimal route adjustments based on:
 * 1. Time window urgency (deliveries close to deadline get priority)
 * 2. Real-time traffic conditions (via Google Directions API)
 * 3. Driver current location
 * 4. Historical delivery success rates
 * 5. Distance clustering (group nearby stops)
 ***/

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { 
      driverId, 
      deliveryDate, 
      currentLocation = null,
      currentLocalTime = null
    } = await req.json();

    if (!driverId || !deliveryDate) {
      return Response.json({ 
        error: 'Missing required parameters: driverId, deliveryDate' 
      }, { status: 400 });
    }

    console.log(`🧠 AI Prioritization analysis for driver ${driverId} on ${deliveryDate}`);

    // Get driver info
    const appUsers = await base44.asServiceRole.entities.AppUser.filter({ user_id: driverId }).catch((error) => {
      if (isNotFoundError(error)) return [];
      throw error;
    });
    const driverAppUser = appUsers?.[0];

    if (!driverAppUser) {
      return Response.json({ error: 'Driver not found' }, { status: 404 });
    }

    // Get all deliveries for the driver
    const allDeliveries = await base44.asServiceRole.entities.Delivery.filter({
      driver_id: driverId,
      delivery_date: deliveryDate,
    });

    if (!allDeliveries || allDeliveries.length === 0) {
      return Response.json({ 
        message: 'No deliveries found',
        suggestions: [],
        alerts: []
      });
    }

    // Filter to active deliveries only
    const activeDeliveries = allDeliveries.filter(d => 
      d.status === 'in_transit' || d.status === 'en_route' || d.status === 'pending'
    );

    if (activeDeliveries.length === 0) {
      return Response.json({ 
        message: 'No active deliveries',
        suggestions: [],
        alerts: [],
        routeComplete: true
      });
    }

    // Get patients for coordinates and time windows
    const patientIds = [...new Set(activeDeliveries.filter(d => d.patient_id).map(d => d.patient_id))];
    const patients = patientIds.length > 0 
      ? await base44.asServiceRole.entities.Patient.filter({ id: { $in: patientIds } })
      : [];
    const patientMap = new Map(patients.map(p => [p.id, p]));

    // Get stores for pickup coordinates
    const storeIds = [...new Set(allDeliveries.map(d => d.store_id).filter(Boolean))];
    const stores = storeIds.length > 0
      ? await base44.asServiceRole.entities.Store.filter({ id: { $in: storeIds } })
      : [];
    const storeMap = new Map(stores.map(s => [s.id, s]));

    // Determine driver's current location
    let driverLocation = null;
    if (currentLocation?.lat && currentLocation?.lng) {
      driverLocation = { lat: currentLocation.lat, lng: currentLocation.lng };
    } else if (driverAppUser.current_latitude && driverAppUser.current_longitude) {
      driverLocation = { lat: driverAppUser.current_latitude, lng: driverAppUser.current_longitude };
    } else if (driverAppUser.home_latitude && driverAppUser.home_longitude) {
      driverLocation = { lat: driverAppUser.home_latitude, lng: driverAppUser.home_longitude };
    }

    // CRITICAL: Use device's local time to avoid UTC timezone issues
    let currentMinutes;
    if (currentLocalTime) {
      // currentLocalTime format: "14:30" (already in local time)
      const [hours, minutes] = currentLocalTime.split(':').map(Number);
      currentMinutes = hours * 60 + minutes;
      console.log(`🕐 [AI Prioritization] Using device local time: ${currentLocalTime} (${currentMinutes} minutes)`);
    } else {
      // Fallback to server time (may be UTC - not ideal)
      const now = new Date();
      currentMinutes = now.getHours() * 60 + now.getMinutes();
      console.warn(`⚠️ [AI Prioritization] No local time provided, using server time: ${now.getHours()}:${now.getMinutes()}`);
    }

    // Analyze each delivery
    const deliveryAnalysis = [];
    const alerts = [];
    const suggestions = [];

    for (const delivery of activeDeliveries) {
      const patient = patientMap.get(delivery.patient_id);
      const store = storeMap.get(delivery.store_id);
      
      // Determine stop name - use patient name, delivery patient_name field, or store name for pickups
      const isPickup = !delivery.patient_id;
      const stopName = delivery.patient_name || patient?.full_name || (isPickup ? `${store?.name || 'Store'} Pickup` : 'Unknown');
      
      let lat, lng;
      if (delivery.patient_id && patient) {
        lat = patient.latitude;
        lng = patient.longitude;
      } else if (store) {
        lat = store.latitude;
        lng = store.longitude;
      }

      if (!lat || !lng) continue;

      // Parse time windows
      const timeWindowStart = parseTimeToMinutes(delivery.time_window_start || delivery.delivery_time_start);
      const timeWindowEnd = parseTimeToMinutes(delivery.time_window_end || delivery.delivery_time_end);

      // Calculate distance from driver
      let distanceKm = null;
      let estimatedTravelMinutes = null;
      if (driverLocation) {
        distanceKm = haversineDistance(driverLocation.lat, driverLocation.lng, lat, lng);
        estimatedTravelMinutes = Math.ceil(distanceKm / 35 * 60); // ~35 km/h urban average
      }

      // Calculate urgency score (0-100)
      let urgencyScore = 0;
      let urgencyReasons = [];

      // Time window urgency
      if (timeWindowEnd !== null) {
        const minutesUntilDeadline = timeWindowEnd - currentMinutes;
        
        if (minutesUntilDeadline < 0) {
          urgencyScore += 100;
          urgencyReasons.push('⚠️ Past deadline!');
          alerts.push({
            type: 'deadline_passed',
            severity: 'critical',
            deliveryId: delivery.id,
            patientName: stopName,
            message: `${stopName} is past its time window (ended at ${formatMinutes(timeWindowEnd)})`
          });
        } else if (minutesUntilDeadline < 30) {
          urgencyScore += 80;
          urgencyReasons.push('⏰ Less than 30 min to deadline');
          alerts.push({
            type: 'deadline_approaching',
            severity: 'warning',
            deliveryId: delivery.id,
            patientName: stopName,
            message: `${stopName}: Only ${minutesUntilDeadline} minutes until deadline`
          });
        } else if (minutesUntilDeadline < 60) {
          urgencyScore += 50;
          urgencyReasons.push('⏱️ Less than 1 hour to deadline');
        } else if (minutesUntilDeadline < 120) {
          urgencyScore += 25;
        }

        // Check if we can make it in time
        if (estimatedTravelMinutes !== null && estimatedTravelMinutes > minutesUntilDeadline) {
          urgencyScore += 30;
          urgencyReasons.push('🚗 May not reach in time!');
          if (minutesUntilDeadline > 0) {
            alerts.push({
              type: 'time_risk',
              severity: 'warning',
              deliveryId: delivery.id,
              patientName: stopName,
              message: `${stopName}: ETA ${estimatedTravelMinutes} min but only ${minutesUntilDeadline} min until deadline`
            });
          }
        }
      }

      // Waiting since time window started
      if (timeWindowStart !== null && currentMinutes > timeWindowStart) {
        const waitingMinutes = currentMinutes - timeWindowStart;
        if (waitingMinutes > 60) {
          urgencyScore += 20;
          urgencyReasons.push(`⌛ Customer waiting ${waitingMinutes} min`);
        }
      }

      // Priority flags
      if (delivery.fridge_item) {
        urgencyScore += 15;
        urgencyReasons.push('🧊 Refrigerated item');
      }
      if (delivery.signature_needed) {
        urgencyScore += 5;
        urgencyReasons.push('✍️ Signature required');
      }
      if (delivery.cod_total_amount_required > 0) {
        urgencyScore += 5;
        urgencyReasons.push('💵 COD collection');
      }

      // Distance bonus for nearby stops
      if (distanceKm !== null && distanceKm < 2) {
        urgencyScore += 10;
        urgencyReasons.push('📍 Very close');
      }

      deliveryAnalysis.push({
        deliveryId: delivery.id,
        patientName: stopName,
        address: patient?.address || store?.address || '',
        lat,
        lng,
        currentStopOrder: delivery.stop_order,
        distanceKm: distanceKm ? Math.round(distanceKm * 10) / 10 : null,
        estimatedTravelMinutes,
        timeWindowStart: timeWindowStart !== null ? formatMinutes(timeWindowStart) : null,
        timeWindowEnd: timeWindowEnd !== null ? formatMinutes(timeWindowEnd) : null,
        urgencyScore: Math.min(urgencyScore, 100),
        urgencyReasons,
        status: delivery.status,
        isFridge: delivery.fridge_item || false,
        isSignature: delivery.signature_needed || false,
        isCOD: (delivery.cod_total_amount_required || 0) > 0
      });
    }

    // Sort by urgency score
    deliveryAnalysis.sort((a, b) => b.urgencyScore - a.urgencyScore);

    // Generate smart suggestions
    const topUrgent = deliveryAnalysis.filter(d => d.urgencyScore >= 50);
    
    if (topUrgent.length > 0) {
      const mostUrgent = topUrgent[0];
      if (mostUrgent.currentStopOrder > 1) {
        suggestions.push({
          type: 'reorder',
          priority: 'high',
          title: 'Prioritize Urgent Delivery',
          description: `Move "${mostUrgent.patientName}" to next stop (urgency: ${mostUrgent.urgencyScore}%)`,
          deliveryId: mostUrgent.deliveryId,
          reasoning: mostUrgent.urgencyReasons.join(', '),
          action: {
            type: 'move_to_next',
            deliveryId: mostUrgent.deliveryId
          }
        });
      }
    }

    // Check for clustering opportunity
    if (deliveryAnalysis.length >= 3 && driverLocation) {
      const clusters = findClusters(deliveryAnalysis, 2); // 2km radius
      const largestCluster = clusters.sort((a, b) => b.length - a.length)[0];
      
      if (largestCluster && largestCluster.length >= 3) {
        const clusterNames = largestCluster.slice(0, 3).map(d => d.patientName).join(', ');
        suggestions.push({
          type: 'cluster',
          priority: 'medium',
          title: 'Group Nearby Stops',
          description: `${largestCluster.length} stops are within 2km: ${clusterNames}${largestCluster.length > 3 ? '...' : ''}`,
          deliveryIds: largestCluster.map(d => d.deliveryId),
          reasoning: 'Grouping nearby stops reduces travel time'
        });
      }
    }

    // Get traffic conditions if Google API is available
    let trafficConditions = null;
    const googleMapsKey = Deno.env.get('GOOGLE_MAPS_API_KEY');
    
    if (googleMapsKey && driverLocation && deliveryAnalysis.length > 0) {
      const nextStop = deliveryAnalysis.find(d => d.currentStopOrder === 1) || deliveryAnalysis[0];
      if (nextStop) {
        try {
          const trafficData = await getTrafficConditions(
            driverLocation, 
            { lat: nextStop.lat, lng: nextStop.lng },
            googleMapsKey
          );
          trafficConditions = trafficData;
          
          if (trafficData.congestionLevel === 'heavy') {
            alerts.push({
              type: 'traffic',
              severity: 'info',
              message: `Heavy traffic to next stop - expect ${trafficData.delayMinutes || 0}+ min delay`
            });
          }
        } catch (e) {
          console.warn('Traffic check failed:', e.message);
        }
      }
    }

    // Log the analysis
    await base44.asServiceRole.entities.GoogleAPILog.create({
      timestamp: new Date().toISOString(),
      api_type: 'Directions',
      purpose: `AI prioritization analysis for driver ${driverAppUser.user_name || driverId}`,
      function_name: 'aiDeliveryPrioritization',
      user_id: user.id,
      user_name: user.full_name,
      metadata: {
        driver_id: driverId,
        delivery_date: deliveryDate,
        deliveries_analyzed: deliveryAnalysis.length,
        alerts_generated: alerts.length,
        suggestions_generated: suggestions.length
      }
    });

    return Response.json({
      success: true,
      driverId,
      deliveryDate,
      currentTime: formatMinutes(currentMinutes),
      driverLocation,
      deliveryAnalysis,
      alerts: alerts.sort((a, b) => {
        const severityOrder = { critical: 0, warning: 1, info: 2 };
        return (severityOrder[a.severity] || 3) - (severityOrder[b.severity] || 3);
      }),
      suggestions,
      trafficConditions,
      summary: {
        totalActive: activeDeliveries.length,
        urgentCount: topUrgent.length,
        atRiskCount: alerts.filter(a => a.severity === 'critical' || a.severity === 'warning').length
      }
    });

  } catch (error) {
    console.error('❌ Error in AI prioritization:', error);
    return Response.json({ 
      error: error.message,
      stack: error.stack 
    }, { status: 500 });
  }
});

function parseTimeToMinutes(timeStr) {
  if (!timeStr) return null;
  const parts = timeStr.split(':');
  if (parts.length !== 2) return null;
  const [hours, minutes] = parts.map(Number);
  if (isNaN(hours) || isNaN(minutes)) return null;
  return hours * 60 + minutes;
}

function formatMinutes(totalMinutes) {
  const hours = Math.floor(totalMinutes / 60) % 24;
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function findClusters(deliveries, radiusKm) {
  const clusters = [];
  const used = new Set();

  for (const delivery of deliveries) {
    if (used.has(delivery.deliveryId)) continue;
    
    const cluster = [delivery];
    used.add(delivery.deliveryId);

    for (const other of deliveries) {
      if (used.has(other.deliveryId)) continue;
      const dist = haversineDistance(delivery.lat, delivery.lng, other.lat, other.lng);
      if (dist <= radiusKm) {
        cluster.push(other);
        used.add(other.deliveryId);
      }
    }

    if (cluster.length > 1) {
      clusters.push(cluster);
    }
  }

  return clusters;
}

async function getTrafficConditions(origin, destination, apiKey) {
  const url = `https://maps.googleapis.com/maps/api/directions/json?` +
    `origin=${origin.lat},${origin.lng}&` +
    `destination=${destination.lat},${destination.lng}&` +
    `departure_time=now&` +
    `traffic_model=best_guess&` +
    `key=${apiKey}`;

  const response = await fetch(url);
  const data = await response.json();

  if (data.status !== 'OK' || !data.routes?.[0]?.legs?.[0]) {
    return { congestionLevel: 'unknown' };
  }

  const leg = data.routes[0].legs[0];
  const normalDuration = leg.duration?.value || 0;
  const trafficDuration = leg.duration_in_traffic?.value || normalDuration;
  
  const delaySeconds = trafficDuration - normalDuration;
  const delayMinutes = Math.round(delaySeconds / 60);
  const delayRatio = normalDuration > 0 ? trafficDuration / normalDuration : 1;

  let congestionLevel = 'light';
  if (delayRatio > 1.5) congestionLevel = 'heavy';
  else if (delayRatio > 1.2) congestionLevel = 'moderate';

  return {
    normalMinutes: Math.round(normalDuration / 60),
    trafficMinutes: Math.round(trafficDuration / 60),
    delayMinutes,
    congestionLevel,
    distanceKm: Math.round((leg.distance?.value || 0) / 100) / 10
  };
}