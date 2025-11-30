import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Bot, Sparkles, RefreshCw, CheckCircle, TrendingUp, Clock, MapPin, AlertTriangle, X } from 'lucide-react';
import { format } from 'date-fns';
import { motion, AnimatePresence } from 'framer-motion';

export default function AIRoutePlanner({
  deliveries = [],
  patients = [],
  stores = [],
  drivers = [],
  currentUser,
  selectedDate,
  selectedDriverId,
  onApplyOptimization,
  onClose,
  onAnalyzingChange
}) {
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysis, setAnalysis] = useState(null);
  const [suggestions, setSuggestions] = useState([]);
  const [isApplying, setIsApplying] = useState(false);
  const [hasSignificantIssues, setHasSignificantIssues] = useState(false);
  const [storesWithMultiplePickups, setStoresWithMultiplePickups] = useState(new Set());

  const analyzeRoute = async () => {
    try {
      setIsAnalyzing(true);
      if (onAnalyzingChange) onAnalyzingChange(true);
      setAnalysis(null);
      setSuggestions([]);
      setHasSignificantIssues(false);

      const dateStr = format(selectedDate, 'yyyy-MM-dd');
      const driverFilter = selectedDriverId !== 'all' ? 
        deliveries.filter(d => d && d.driver_id === selectedDriverId) : 
        deliveries;

      const activeDeliveries = driverFilter.filter(d => 
        d && d.delivery_date === dateStr && 
        !['completed', 'failed', 'cancelled', 'returned', 'pending'].includes(d.status)
      );

      if (activeDeliveries.length === 0) {
        setAnalysis({ message: 'No active deliveries to optimize for the selected date and driver.' });
        setHasSignificantIssues(true);
        return;
      }
      
      const pickupCounts = activeDeliveries
        .filter(d => d && !d.patient_id)
        .reduce((acc, pickup) => {
          if (pickup.store_id) {
            acc[pickup.store_id] = (acc[pickup.store_id] || 0) + 1;
          }
          return acc;
        }, {});

      const multiPickupStores = new Set(
        Object.keys(pickupCounts).filter(storeId => pickupCounts[storeId] > 1)
      );
      setStoresWithMultiplePickups(multiPickupStores);

      // Build route data for AI analysis
      const routeData = activeDeliveries.map((delivery, idx) => {
        const deliveryPatient = patients.find(p => p && p.id === delivery.patient_id);
        const deliveryStore = stores.find(s => s && s.id === delivery.store_id);
        const isPickup = !delivery.patient_id;
        
        let name;
        if (isPickup) {
            const storeName = deliveryStore?.name || 'Unknown Store';
            if (multiPickupStores.has(delivery.store_id)) {
                name = `${storeName} [${delivery.ampm_deliveries || 'N/A'}] Pickup`;
            } else {
                name = `${storeName} Pickup`;
            }
        } else {
            name = deliveryPatient?.full_name || 'Unknown';
        }

        return {
          id: delivery.id,
          stop_number: idx + 1,
          current_stop_order: delivery.stop_order || idx + 1,
          name: name,
          address: isPickup ? deliveryStore?.address : deliveryPatient?.address,
          latitude: isPickup ? deliveryStore?.latitude : deliveryPatient?.latitude,
          longitude: isPickup ? deliveryStore?.longitude : deliveryPatient?.longitude,
          is_pickup: isPickup,
          store_name: deliveryStore?.name,
          scheduled_time_window: {
            start: delivery.time_window_start || delivery.delivery_time_start,
            end: delivery.time_window_end || delivery.delivery_time_end
          },
          current_eta: delivery.delivery_time_eta,
          status: delivery.status,
          priority_flags: {
            signature_needed: delivery.signature_needed,
            cod_required: delivery.cod_total_amount_required > 0,
            fridge_item: delivery.fridge_item,
            oversized: delivery.oversized,
            first_delivery: delivery.first_delivery
          },
          extra_time_minutes: delivery.extra_time || 5
        };
      });

      // Get driver info
      const driver = drivers.find(d => d && d.id === selectedDriverId) || 
                    (selectedDriverId === 'all' ? null : drivers[0]);

      let currentLocation = null;
      let startLocationSource = null;

      if (driver) {
        // Try current GPS location first
        if (driver.current_latitude && driver.current_longitude) {
          currentLocation = {
            latitude: driver.current_latitude,
            longitude: driver.current_longitude
          };
          startLocationSource = 'GPS';
        } else {
          // Fall back to last completed delivery
          const completedDeliveries = deliveries
            .filter(d => d && d.driver_id === driver.id && d.delivery_date === dateStr && 
                         ['completed', 'failed', 'cancelled', 'returned'].includes(d.status))
            .sort((a, b) => {
              const timeA = a.actual_delivery_time ? new Date(a.actual_delivery_time).getTime() : 0;
              const timeB = b.actual_delivery_time ? new Date(b.actual_delivery_time).getTime() : 0;
              return timeB - timeA; // Most recent first
            });

          if (completedDeliveries.length > 0) {
            const lastCompleted = completedDeliveries[0];
            const patient = patients.find(p => p && p.id === lastCompleted.patient_id);
            const store = stores.find(s => s && s.id === lastCompleted.store_id);

            if (patient?.latitude && patient?.longitude) {
              currentLocation = {
                latitude: patient.latitude,
                longitude: patient.longitude
              };
              startLocationSource = 'Last Completed Delivery';
            } else if (store?.latitude && store?.longitude) {
              currentLocation = {
                latitude: store.latitude,
                longitude: store.longitude
              };
              startLocationSource = 'Last Completed Pickup';
            }
          }
        }
      }

      const driverInfo = driver ? {
        name: driver.user_name || driver.full_name,
        current_location: currentLocation,
        start_location_source: startLocationSource,
        home_location: driver.home_latitude && driver.home_longitude ? {
          latitude: driver.home_latitude,
          longitude: driver.home_longitude
        } : null
      } : null;

      const currentTime = format(new Date(), 'HH:mm');
      const currentTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

      // Call LLM for route analysis
      const prompt = `You are an expert logistics AI assistant helping optimize delivery routes for pharmacy deliveries.

      CURRENT SITUATION:
      - Date: ${dateStr}
      - Current Time: ${currentTime} (${currentTimezone} timezone)
      - Driver: ${driverInfo?.name || 'Multiple drivers'}
      ${driverInfo?.current_location ? `- Driver Current Location: ${driverInfo.current_location.latitude}, ${driverInfo.current_location.longitude} (Source: ${driverInfo.start_location_source})` : ''}
      ${driverInfo?.home_location ? `- Driver Home: ${driverInfo.home_location.latitude}, ${driverInfo.home_location.longitude}` : ''}
      - Total Active Stops: ${routeData.length}

IMPORTANT TIMEZONE NOTE:
- All times provided (current time and time windows) are in ${currentTimezone} timezone
- Use this timezone for all time calculations and comparisons
- Do NOT convert times or assume UTC

TIME WINDOW INTERPRETATION (CRITICAL):
- "scheduled_time_window.start" = EARLIEST time the delivery can be made (customer available FROM this time onward)
- "scheduled_time_window.end" = LATEST acceptable delivery time (delivery is LATE only if ETA is AFTER this time)
- A delivery is ON TIME if: ETA >= start time (or no start time exists)
- A delivery is POTENTIALLY LATE only if: ETA > end time (when end time exists)
- If only start time exists (no end time): delivery can happen anytime AFTER start time - NOT late
- If neither exist: delivery has maximum flexibility - can be scheduled anytime
- Example: time window 14:30-16:00 means deliver anytime from 2:30 PM onward, but preferably before 4:00 PM
- IMPORTANT: Arriving AFTER the start time is NORMAL and EXPECTED, not late!

ROUTE DATA:
${JSON.stringify(routeData, null, 2)}

OPTIMIZATION RULES (IN PRIORITY ORDER):
1. START FROM DRIVER'S CURRENT LOCATION: ${driverInfo?.current_location ? 'The driver is currently at the location shown above. Begin route optimization from this point.' : 'No current location available - optimize from the first stop.'}
2. PICKUP TIME WINDOWS ARE FIXED: Pickups have scheduled time windows that MUST be respected. Do NOT move pickups to accommodate delivery ordering - instead, move deliveries around pickups.
3. CRITICAL: Each store's pickup MUST come before THAT STORE'S deliveries (not all pickups before all deliveries)
   - Store A pickup → Store A deliveries → Store B pickup → Store B deliveries (interleaved is OK)
   - NOT: Store A pickup → Store B pickup → Store A deliveries → Store B deliveries (grouped is WRONG)
   - IMPORTANT: To enforce this rule, MOVE DELIVERIES to come after their pickup, do NOT move pickups earlier
4. EXCEPTIONS to pickup-before-delivery rule:
   - Deliveries with "interstore" in the name or notes can be ordered BEFORE their pickup store (they are inter-store transfers)
   - Deliveries with a time window that ENDS BEFORE the pickup's time window starts can be placed before the pickup (likely leftovers from prior day or emergency deliveries)
5. RESPECT TIME WINDOWS: Maintain delivery time windows (delivery_time_start to delivery_time_end) whenever possible
   - If a stop has a time window, try to schedule it within that window
   - Time windows are commitments to customers and should be prioritized over distance savings
   - Only deviate from time windows if absolutely necessary due to constraints
   - FLEXIBILITY: Stops WITHOUT time windows can be optimized at ANY point in the route (maximum flexibility)
6. Optimize for shortest total distance from current location - pickups and deliveries should be interleaved based on geographic proximity
   - Balance distance optimization with time window compliance
   - Use stops without time windows as "flexible filler" to optimize overall route efficiency
7. Consider priority flags (signature, COD, fridge items, first delivery)
8. Account for extra time at each stop (typically 5-15 minutes)
9. Consider traffic patterns typical for this time of day

TASK:
Analyze this route and provide:
1. Overall assessment of current route efficiency (1-10 score)
2. Key issues or inefficiencies identified
3. Optimized stop order with reasoning - prioritize maintaining time windows while creating shortest route
4. Estimated time savings
5. Any warnings or considerations (especially time window conflicts)

IMPORTANT LATENESS RULES:
- A delivery is ONLY considered late if ETA is AFTER the end time (when end time exists)
- Arriving after the start time is NORMAL - that's when the customer becomes available
- If no end time exists, the delivery cannot be "late" - only "too early" if before start time
- Do NOT flag deliveries as late just because they arrive after the start time
- Focus on ensuring deliveries arrive BEFORE end time (when specified)

Be specific and actionable. Focus on practical improvements.`;

      const response = await base44.integrations.Core.InvokeLLM({
        prompt: prompt,
        add_context_from_internet: true,
        response_json_schema: {
          type: 'object',
          properties: {
            efficiency_score: {
              type: 'number',
              description: 'Current route efficiency score 1-10'
            },
            issues: {
              type: 'array',
              items: { type: 'string' },
              description: 'List of identified issues'
            },
            optimized_route: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  delivery_id: { type: 'string' },
                  new_stop_order: { type: 'number' },
                  reasoning: { type: 'string' }
                }
              },
              description: 'Optimized stop order with reasoning'
            },
            estimated_time_savings_minutes: {
              type: 'number',
              description: 'Estimated time savings in minutes'
            },
            summary: {
              type: 'string',
              description: 'Brief summary of optimization strategy'
            },
            warnings: {
              type: 'array',
              items: { type: 'string' },
              description: 'Warnings or considerations'
            }
          },
          required: ['efficiency_score', 'issues', 'optimized_route', 'summary']
        }
      });

      setAnalysis(response);
      
      // Convert AI suggestions to update format with correct stop numbering
      if (response.optimized_route && Array.isArray(response.optimized_route)) {
        // Find the highest stop_order among completed deliveries for this driver
        const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
        const completedDeliveries = driverFilter.filter(d => 
          d && d.delivery_date === dateStr && finishedStatuses.includes(d.status)
        );
        
        const lastCompletedStopOrder = completedDeliveries.length > 0 
          ? Math.max(...completedDeliveries.map(d => d.stop_order || 0))
          : 0;
        
        console.log(`AI Route Planner: Last completed stop order = ${lastCompletedStopOrder}, starting new sequence at ${lastCompletedStopOrder + 1}`);
        
        const updates = response.optimized_route.map((item, idx) => ({
          id: item.delivery_id,
          stop_order: lastCompletedStopOrder + idx + 1, // Continue from last completed
          reasoning: item.reasoning
        }));
        setSuggestions(updates);
        
        // Check if there are significant issues
        const hasErrors = response.error;
        const hasIssues = response.issues && response.issues.length > 0;
        const hasWarnings = response.warnings && response.warnings.length > 0;
        const lowEfficiency = response.efficiency_score < 7;
        
        const significant = hasErrors || hasIssues || hasWarnings || lowEfficiency;
        setHasSignificantIssues(significant);
        
        // Auto-apply if only ETA updates (no significant issues)
        if (!significant && updates.length > 0) {
          console.log('✅ [AI Route Planner] No significant issues - auto-applying optimization');
          setIsApplying(true);
          try {
            await onApplyOptimization(updates);
            if (onClose) onClose();
          } catch (error) {
            console.error('❌ [AI Route Planner] Auto-apply error:', error);
            setHasSignificantIssues(true); // Show modal on error
          } finally {
            setIsApplying(false);
          }
        }
      }

    } catch (error) {
      console.error('AI Route Analysis Error:', error);
      setAnalysis({ 
        error: true, 
        message: error.message || 'Failed to analyze route. Please try again.' 
      });
      setHasSignificantIssues(true);
    } finally {
      setIsAnalyzing(false);
      if (onAnalyzingChange) onAnalyzingChange(false);
    }
  };

  // Auto-start analysis when component mounts
  useEffect(() => {
    analyzeRoute();
  }, []);

  // Handle ESC key to close
  useEffect(() => {
    const handleEsc = (e) => {
      if (e.key === 'Escape' && onClose) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [onClose]);

  const handleApplyOptimization = async () => {
    if (!suggestions.length || !onApplyOptimization) return;

    try {
      setIsApplying(true);
      
      // Pass suggestions with flag to recalculate ETAs, update stop orders, then center
      await onApplyOptimization(suggestions, { recalculateETAs: true, autoCenterNext: true });
      
      setAnalysis(null);
      setSuggestions([]);
      setHasSignificantIssues(false);
      if (onClose) onClose();
    } catch (error) {
      console.error('Error applying optimization:', error);
      alert('Failed to apply optimization. Please try again.');
    } finally {
      setIsApplying(false);
    }
  };

  // Only show modal if there are significant issues
  if (!hasSignificantIssues && !isAnalyzing) {
    return null;
  }

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      className="fixed inset-4 z-[10000] flex items-center justify-center p-4 bg-black/50">
      
      <Card className="w-full max-w-3xl max-h-[85vh] overflow-hidden bg-white">
        <div className="sticky top-0 bg-gradient-to-r from-purple-600 to-blue-600 text-white p-6 z-10">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-white/20 rounded-lg">
                <Sparkles className="w-6 h-6" />
              </div>
              <div>
                <h2 className="text-xl font-bold">AI Route Planner</h2>
                <p className="text-sm text-white/80">Intelligent route optimization powered by AI</p>
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={onClose}
              className="text-white hover:bg-white/20 h-8 w-8 p-0">
              <X className="w-5 h-5" />
            </Button>
          </div>
        </div>

        <div className="p-6 overflow-y-auto max-h-[calc(85vh-120px)]">
          {isAnalyzing && (
            <div className="text-center py-12">
              <div className="animate-spin w-12 h-12 border-4 border-purple-600 border-t-transparent rounded-full mx-auto mb-4"></div>
              <p className="text-slate-600 font-medium">AI is analyzing your route...</p>
              <p className="text-sm text-slate-500 mt-2">Considering locations, time windows, and constraints</p>
            </div>
          )}

          <AnimatePresence>
            {analysis && !isAnalyzing && hasSignificantIssues && (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="space-y-6">
                
                {analysis.error ? (
                  <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                    <div className="flex items-center gap-2 text-red-800 font-semibold mb-2">
                      <AlertTriangle className="w-5 h-5" />
                      Analysis Error
                    </div>
                    <p className="text-red-700 text-sm">{analysis.message}</p>
                  </div>
                ) : analysis.message ? (
                  <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                    <p className="text-blue-800">{analysis.message}</p>
                  </div>
                ) : (
                  <>
                    {/* Efficiency Score */}
                    <div className="bg-gradient-to-br from-purple-50 to-blue-50 rounded-xl p-6 border border-purple-200">
                      <div className="flex items-center justify-between">
                        <div>
                          <h3 className="text-lg font-semibold text-slate-900 mb-1">Route Efficiency</h3>
                          <p className="text-sm text-slate-600">Current route performance</p>
                        </div>
                        <div className="text-right">
                          <div className="text-4xl font-bold text-purple-600">
                            {analysis.efficiency_score}/10
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Summary */}
                    {analysis.summary && (
                      <div className="bg-white border border-slate-200 rounded-lg p-4">
                        <h4 className="font-semibold text-slate-900 mb-2 flex items-center gap-2">
                          <TrendingUp className="w-4 h-4 text-blue-600" />
                          Optimization Strategy
                        </h4>
                        <p className="text-slate-700 text-sm leading-relaxed">{analysis.summary}</p>
                      </div>
                    )}

                    {/* Issues Identified */}
                    {analysis.issues && analysis.issues.length > 0 && (
                      <div>
                        <h4 className="font-semibold text-slate-900 mb-3 flex items-center gap-2">
                          <AlertTriangle className="w-4 h-4 text-amber-600" />
                          Issues Identified
                        </h4>
                        <div className="space-y-2">
                          {analysis.issues.map((issue, idx) => (
                            <div key={idx} className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                              <p className="text-sm text-amber-900">{issue}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Optimized Route */}
                    {suggestions.length > 0 && (
                      <div>
                        <div className="flex items-center justify-between mb-3">
                          <h4 className="font-semibold text-slate-900 flex items-center gap-2">
                            <MapPin className="w-4 h-4 text-emerald-600" />
                            Suggested Route Order
                          </h4>
                          {analysis.estimated_time_savings_minutes > 0 && (
                            <Badge className="bg-emerald-100 text-emerald-800 gap-1">
                              <Clock className="w-3 h-3" />
                              Save ~{analysis.estimated_time_savings_minutes} min
                            </Badge>
                          )}
                        </div>
                        
                        <div className="space-y-2 max-h-[300px] overflow-y-auto">
                          {suggestions.map((suggestion, idx) => {
                            const delivery = deliveries.find(d => d && d.id === suggestion.id);
                            if (!delivery) return null;

                            const patient = patients.find(p => p && p.id === delivery.patient_id);
                            const store = stores.find(s => s && s.id === delivery.store_id);
                            const isPickup = !delivery.patient_id;
                            
                            let name;
                            if (isPickup) {
                              const storeName = store?.name || 'Unknown Store';
                              const hasMultiplePickups = storesWithMultiplePickups.has(delivery.store_id);
                              name = hasMultiplePickups 
                                ? `${storeName} [${delivery.ampm_deliveries || 'N/A'}] Pickup` 
                                : `${storeName} Pickup`;
                            } else {
                              name = patient?.full_name;
                            }

                            return (
                              <div key={suggestion.id} className="bg-slate-50 border border-slate-200 rounded-lg p-3">
                                <div className="flex items-start gap-3">
                                  <Badge variant="secondary" className="bg-purple-100 text-purple-700 font-bold min-w-[32px] justify-center">
                                    #{suggestion.stop_order}
                                  </Badge>
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 mb-1">
                                      <p className="font-semibold text-slate-900 truncate">{name}</p>
                                      {delivery.current_stop_order !== suggestion.stop_order && (
                                        <Badge variant="outline" className="text-xs">
                                          was #{delivery.stop_order || idx + 1}
                                        </Badge>
                                      )}
                                    </div>
                                    {suggestion.reasoning && (
                                      <p className="text-xs text-slate-600 leading-relaxed">{suggestion.reasoning}</p>
                                    )}
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* Warnings */}
                    {analysis.warnings && analysis.warnings.length > 0 && (
                      <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                        <h4 className="font-semibold text-yellow-900 mb-2 flex items-center gap-2">
                          <AlertTriangle className="w-4 h-4" />
                          Considerations
                        </h4>
                        <ul className="space-y-1">
                          {analysis.warnings.map((warning, idx) => (
                            <li key={idx} className="text-sm text-yellow-800 flex items-start gap-2">
                              <span className="text-yellow-600 mt-0.5">•</span>
                              <span>{warning}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* Action Buttons */}
                    {suggestions.length > 0 && (
                      <div className="flex gap-3 pt-4 border-t border-slate-200">
                        <Button
                          variant="outline"
                          className="flex-1"
                          onClick={analyzeRoute}
                          disabled={isApplying}>
                          <RefreshCw className="w-4 h-4 mr-2" />
                          Re-analyze
                        </Button>
                        <Button
                          className="flex-1 bg-emerald-600 hover:bg-emerald-700"
                          onClick={handleApplyOptimization}
                          disabled={isApplying}>
                          {isApplying ? (
                            <>
                              <div className="animate-spin w-4 h-4 border-2 border-white border-t-transparent rounded-full mr-2"></div>
                              Applying...
                            </>
                          ) : (
                            <>
                              <CheckCircle className="w-4 h-4 mr-2" />
                              Apply Optimization
                            </>
                          )}
                        </Button>
                      </div>
                    )}
                  </>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </Card>
    </motion.div>
  );
}