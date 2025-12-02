import React, { useEffect, useRef, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import { format } from 'date-fns';
import { toast } from 'sonner';

/**
 * Proactive Alert System - Monitors route conditions and alerts drivers
 * Checks every 5 minutes for:
 * - Traffic delays impacting ETAs
 * - Time window violations (deliveries at risk of being late)
 * - High-priority deliveries that need attention
 */
export default function ProactiveAlertSystem({ 
  currentUser, 
  deliveries, 
  patients, 
  stores,
  driverLocation,
  isEnabled = true,
  onAlert 
}) {
  const lastCheckRef = useRef(null);
  const alertedDeliveriesRef = useRef(new Set());
  
  const analyzeRouteForAlerts = useCallback(async () => {
    if (!currentUser?.id || !deliveries?.length || !isEnabled) return;
    
    const today = format(new Date(), 'yyyy-MM-dd');
    const now = new Date();
    const currentTimeMinutes = now.getHours() * 60 + now.getMinutes();
    
    // Get today's incomplete deliveries for this driver
    const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
    const activeDeliveries = deliveries.filter(d => 
      d && 
      d.driver_id === currentUser.id &&
      d.delivery_date === today &&
      !finishedStatuses.includes(d.status) &&
      d.patient_id // Only patient deliveries, not pickups
    );
    
    if (activeDeliveries.length === 0) return;
    
    const alerts = [];
    
    // Check each delivery for potential issues
    for (const delivery of activeDeliveries) {
      // Skip if already alerted for this delivery in this session
      if (alertedDeliveriesRef.current.has(delivery.id)) continue;
      
      const patient = patients.find(p => p?.id === delivery.patient_id);
      const store = stores.find(s => s?.id === delivery.store_id);
      
      // Parse time window end
      if (delivery.delivery_time_end) {
        const [endHours, endMinutes] = delivery.delivery_time_end.split(':').map(Number);
        const endTimeMinutes = endHours * 60 + endMinutes;
        
        // Parse ETA
        let etaMinutes = null;
        if (delivery.delivery_time_eta) {
          const [etaHours, etaMins] = delivery.delivery_time_eta.split(':').map(Number);
          etaMinutes = etaHours * 60 + etaMins;
        }
        
        // Calculate time remaining until window closes
        const timeUntilWindowCloses = endTimeMinutes - currentTimeMinutes;
        
        // ALERT 1: Time window closing soon (< 30 min) and ETA might miss it
        if (timeUntilWindowCloses > 0 && timeUntilWindowCloses <= 30) {
          if (etaMinutes && etaMinutes > endTimeMinutes - 10) {
            alerts.push({
              type: 'time_window_risk',
              severity: 'high',
              deliveryId: delivery.id,
              patientName: patient?.full_name || delivery.patient_name,
              message: `⚠️ ${patient?.full_name || 'Delivery'} - Time window closes in ${timeUntilWindowCloses} min`,
              suggestion: `Consider prioritizing this stop. ETA ${delivery.delivery_time_eta} is cutting it close.`
            });
            alertedDeliveriesRef.current.add(delivery.id);
          }
        }
        
        // ALERT 2: Already past time window
        if (timeUntilWindowCloses < 0 && timeUntilWindowCloses > -60) {
          alerts.push({
            type: 'time_window_missed',
            severity: 'critical',
            deliveryId: delivery.id,
            patientName: patient?.full_name || delivery.patient_name,
            message: `🚨 ${patient?.full_name || 'Delivery'} - Time window expired ${Math.abs(timeUntilWindowCloses)} min ago`,
            suggestion: `Contact dispatcher or patient to reschedule if needed.`
          });
          alertedDeliveriesRef.current.add(delivery.id);
        }
      }
      
      // ALERT 3: High-priority flags (signature needed, fridge item, first delivery)
      if (delivery.first_delivery && !alertedDeliveriesRef.current.has(`first_${delivery.id}`)) {
        const timeUntilETA = delivery.delivery_time_eta ? 
          (() => {
            const [h, m] = delivery.delivery_time_eta.split(':').map(Number);
            return (h * 60 + m) - currentTimeMinutes;
          })() : null;
        
        if (timeUntilETA && timeUntilETA <= 45 && timeUntilETA > 0) {
          alerts.push({
            type: 'first_delivery_approaching',
            severity: 'medium',
            deliveryId: delivery.id,
            patientName: patient?.full_name || delivery.patient_name,
            message: `📋 First-time delivery to ${patient?.full_name || 'patient'} in ~${timeUntilETA} min`,
            suggestion: `Take extra care - this is their first delivery. Verify address and instructions.`
          });
          alertedDeliveriesRef.current.add(`first_${delivery.id}`);
        }
      }
      
      // ALERT 4: Fridge item reminder
      if (delivery.fridge_item && !alertedDeliveriesRef.current.has(`fridge_${delivery.id}`)) {
        const deliveryIndex = activeDeliveries.indexOf(delivery);
        if (deliveryIndex <= 2) { // Within next 3 stops
          alerts.push({
            type: 'fridge_item_reminder',
            severity: 'medium',
            deliveryId: delivery.id,
            patientName: patient?.full_name || delivery.patient_name,
            message: `❄️ ${patient?.full_name || 'Delivery'} has refrigerated items`,
            suggestion: `Ensure temperature-controlled handling for this stop.`
          });
          alertedDeliveriesRef.current.add(`fridge_${delivery.id}`);
        }
      }
    }
    
    // ALERT 5: Multiple stops at risk (traffic/delay pattern)
    const stopsWithTightWindows = activeDeliveries.filter(d => {
      if (!d.delivery_time_end || !d.delivery_time_eta) return false;
      const [endH, endM] = d.delivery_time_end.split(':').map(Number);
      const [etaH, etaM] = d.delivery_time_eta.split(':').map(Number);
      const buffer = (endH * 60 + endM) - (etaH * 60 + etaM);
      return buffer < 15 && buffer > -30; // Less than 15 min buffer or slightly overdue
    });
    
    if (stopsWithTightWindows.length >= 3 && !alertedDeliveriesRef.current.has('multi_delay')) {
      alerts.push({
        type: 'multiple_delays',
        severity: 'high',
        message: `🚦 ${stopsWithTightWindows.length} stops have tight time windows`,
        suggestion: `Consider contacting dispatch for route adjustment or customer notifications.`
      });
      alertedDeliveriesRef.current.add('multi_delay');
    }
    
    // Trigger alerts
    if (alerts.length > 0) {
      console.log(`🚨 [ProactiveAlerts] Found ${alerts.length} alerts`);
      
      // Show toast for critical/high severity
      const criticalAlerts = alerts.filter(a => a.severity === 'critical' || a.severity === 'high');
      if (criticalAlerts.length > 0) {
        const topAlert = criticalAlerts[0];
        toast.warning(topAlert.message, {
          description: topAlert.suggestion,
          duration: 10000,
          action: topAlert.deliveryId ? {
            label: 'View',
            onClick: () => {
              const cardElement = document.getElementById(`stop-card-${topAlert.deliveryId}`);
              if (cardElement) {
                cardElement.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
              }
            }
          } : undefined
        });
      }
      
      // Notify parent component
      if (onAlert) {
        onAlert(alerts);
      }
    }
    
    lastCheckRef.current = Date.now();
  }, [currentUser, deliveries, patients, stores, isEnabled, onAlert]);
  
  // Run analysis on mount and every 5 minutes
  useEffect(() => {
    if (!isEnabled) return;
    
    // Initial check after 30 seconds (let data load)
    const initialTimeout = setTimeout(() => {
      analyzeRouteForAlerts();
    }, 30000);
    
    // Then check every 5 minutes
    const interval = setInterval(() => {
      analyzeRouteForAlerts();
    }, 5 * 60 * 1000);
    
    return () => {
      clearTimeout(initialTimeout);
      clearInterval(interval);
    };
  }, [analyzeRouteForAlerts, isEnabled]);
  
  // Also run when driver location changes significantly
  const lastLocationRef = useRef(null);
  useEffect(() => {
    if (!driverLocation?.latitude || !driverLocation?.longitude) return;
    
    // Check if location changed significantly (> 500m)
    if (lastLocationRef.current) {
      const R = 6371e3; // Earth radius in meters
      const φ1 = lastLocationRef.current.latitude * Math.PI / 180;
      const φ2 = driverLocation.latitude * Math.PI / 180;
      const Δφ = (driverLocation.latitude - lastLocationRef.current.latitude) * Math.PI / 180;
      const Δλ = (driverLocation.longitude - lastLocationRef.current.longitude) * Math.PI / 180;
      const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
                Math.cos(φ1) * Math.cos(φ2) *
                Math.sin(Δλ/2) * Math.sin(Δλ/2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
      const distance = R * c;
      
      // If moved > 500m, re-analyze
      if (distance > 500) {
        lastLocationRef.current = driverLocation;
        // Debounce to avoid too many checks
        const timeSinceLastCheck = Date.now() - (lastCheckRef.current || 0);
        if (timeSinceLastCheck > 60000) { // At least 1 min since last check
          analyzeRouteForAlerts();
        }
      }
    } else {
      lastLocationRef.current = driverLocation;
    }
  }, [driverLocation, analyzeRouteForAlerts]);
  
  // This is a headless component - no UI
  return null;
}