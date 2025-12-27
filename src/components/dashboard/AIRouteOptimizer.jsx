import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { base44 } from '@/api/base44Client';
import { Zap, CheckCircle, XCircle, Clock, MapPin, TrendingDown, Loader2, AlertTriangle } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { format } from 'date-fns';

export default function AIRouteOptimizer({
  deliveries = [],
  currentDriverLocation = null,
  stores = [],
  patients = [],
  onAcceptOptimization,
  currentUser,
  isVisible = true
}) {
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [suggestion, setSuggestion] = useState(null);
  const [lastAnalysis, setLastAnalysis] = useState(null);
  const [error, setError] = useState(null);

  // Auto-analyze when conditions change (every 5 minutes or when location changes significantly)
  useEffect(() => {
    if (!isVisible || !deliveries || !Array.isArray(deliveries) || deliveries.length === 0) return;

    const interval = setInterval(() => {
      analyzeRoute(true);
    }, 5 * 60 * 1000); // Every 5 minutes

    return () => clearInterval(interval);
  }, [deliveries, currentDriverLocation, isVisible]);

  const analyzeRoute = async (isAutomatic = false) => {
    if (isAnalyzing) return;
    if (!deliveries || !Array.isArray(deliveries)) {
      console.warn('[AIRouteOptimizer] Invalid deliveries data');
      return;
    }

    setIsAnalyzing(true);
    setError(null);

    try {
      // Filter active deliveries only
      const activeDeliveries = deliveries.filter((delivery) => 
        delivery && !['completed', 'failed', 'cancelled', 'returned'].includes(delivery.status)
      );

      if (activeDeliveries.length === 0) {
        setSuggestion(null);
        setIsAnalyzing(false);
        return;
      }

      // Build context for AI
      const now = new Date();
      const currentTime = format(now, 'HH:mm');
      const currentHour = now.getHours();
      
      // Determine traffic level based on time
      let trafficLevel = 'light';
      if ((currentHour >= 7 && currentHour <= 9) || (currentHour >= 16 && currentHour <= 18)) {
        trafficLevel = 'heavy';
      } else if ((currentHour >= 11 && currentHour <= 13) || (currentHour >= 14 && currentHour <= 16)) {
        trafficLevel = 'moderate';
      }

      // Build delivery context with enriched data
      const deliveryContext = activeDeliveries.map((delivery) => {
        if (!delivery) return null;
        
        const patient = (patients || []).find((p) => p && p.id === delivery.patient_id);
        const store = (stores || []).find((s) => s && s.id === delivery.store_id);
        
        return {
          id: delivery.id,
          stop_order: delivery.stop_order || delivery.display_stop_order || 0,
          status: delivery.status,
          patient_name: patient?.full_name || store?.name || 'Unknown',
          address: patient?.address || store?.address || '',
          time_window_start: delivery.time_window_start || delivery.delivery_time_start || '',
          time_window_end: delivery.time_window_end || delivery.delivery_time_end || '',
          delivery_time_eta: delivery.delivery_time_eta || '',
          is_pickup: !delivery.patient_id && !!delivery.store_id,
          latitude: patient?.latitude || store?.latitude,
          longitude: patient?.longitude || store?.longitude,
          special_instructions: patient?.notes || delivery.delivery_instructions || '',
          cod_required: (delivery.cod_total_amount_required || 0) > 0,
          signature_needed: delivery.signature_needed || false,
          fridge_item: delivery.fridge_item || false
        };
      }).filter(Boolean);

      const prompt = `You are an expert logistics AI assistant analyzing a delivery route in real-time.

CURRENT SITUATION:
- Current time: ${currentTime}
- Traffic conditions: ${trafficLevel}
- Remaining stops: ${activeDeliveries.length}
${currentDriverLocation ? `- Driver current location: [${currentDriverLocation.latitude?.toFixed(4)}, ${currentDriverLocation.longitude?.toFixed(4)}]` : ''}

CURRENT ROUTE (in order):
${deliveryContext.map((deliveryItem, idx) => `
${idx + 1}. ${deliveryItem.is_pickup ? '🏪 PICKUP' : '📦 DELIVERY'}: ${deliveryItem.patient_name}
   - Address: ${deliveryItem.address}
   - Current order: Stop #${deliveryItem.stop_order}
   - Status: ${deliveryItem.status}
   - Time window: ${deliveryItem.time_window_start || 'None'} - ${deliveryItem.time_window_end || 'None'}
   - ETA: ${deliveryItem.delivery_time_eta || 'Not set'}
   ${deliveryItem.cod_required ? '- COD payment required' : ''}
   ${deliveryItem.signature_needed ? '- Signature required' : ''}
   ${deliveryItem.fridge_item ? '- FRIDGE item (time-sensitive)' : ''}
   ${deliveryItem.special_instructions ? `- Notes: ${deliveryItem.special_instructions.substring(0, 100)}` : ''}
`).join('\n')}

ANALYZE AND PROVIDE:
1. Whether the current route order is optimal
2. If not optimal, suggest a better order considering:
   - Time windows (priority: avoid missing windows)
   - Traffic conditions at current time
   - Proximity and logical flow
   - Special requirements (COD, signatures, fridge items)
   - Pickups must come before their associated deliveries
3. Estimated time savings (in minutes)
4. Specific reasoning for any reordering

Be concise but specific. If the route is already optimal, say so clearly.`;

      console.log('🤖 [AIRouteOptimizer] Analyzing route with AI...');

      const response = await base44.integrations.Core.InvokeLLM({
        prompt,
        response_json_schema: {
          type: 'object',
          properties: {
            is_optimal: {
              type: 'boolean',
              description: 'Whether the current route is optimal'
            },
            suggested_order: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  delivery_id: { type: 'string' },
                  new_stop_order: { type: 'number' },
                  reason: { type: 'string' }
                }
              },
              description: 'Only if not optimal - suggested new order with reasons'
            },
            estimated_time_savings_minutes: {
              type: 'number',
              description: 'Estimated time savings in minutes, 0 if already optimal'
            },
            reasoning: {
              type: 'string',
              description: 'Overall reasoning for the suggestion or why route is optimal'
            },
            urgency_level: {
              type: 'string',
              enum: ['low', 'medium', 'high'],
              description: 'How urgent is this optimization'
            }
          },
          required: ['is_optimal', 'estimated_time_savings_minutes', 'reasoning', 'urgency_level']
        }
      });

      console.log('✅ [AIRouteOptimizer] AI response:', response);

      if (!response.is_optimal && response.suggested_order?.length > 0) {
        setSuggestion({
          ...response,
          timestamp: now,
          isAutomatic
        });
      } else {
        setSuggestion(null);
      }

      setLastAnalysis(now);
    } catch (err) {
      console.error('❌ [AIRouteOptimizer] Error analyzing route:', err);
      setError('Failed to analyze route. Please try again.');
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleAccept = async () => {
    if (!suggestion?.suggested_order) return;

    try {
      // Convert suggested order to updates
      const updates = suggestion.suggested_order.map((item) => ({
        id: item.delivery_id,
        stop_order: item.new_stop_order
      }));

      await onAcceptOptimization(updates);
      
      setSuggestion(null);
    } catch (err) {
      console.error('❌ [AIRouteOptimizer] Error accepting optimization:', err);
      setError('Failed to apply optimization. Please try again.');
    }
  };

  const handleDismiss = () => {
    setSuggestion(null);
  };

  if (!isVisible) return null;

  const activeDeliveries = (deliveries || []).filter((delivery) => 
    delivery && !['completed', 'failed', 'cancelled', 'returned'].includes(delivery.status)
  );

  if (activeDeliveries.length === 0) return null;

  const getUrgencyColor = (level) => {
    switch (level) {
      case 'high': return 'bg-red-100 text-red-700 border-red-300';
      case 'medium': return 'bg-amber-100 text-amber-700 border-amber-300';
      case 'low': return 'bg-blue-100 text-blue-700 border-blue-300';
      default: return 'bg-slate-100 text-slate-700 border-slate-300';
    }
  };

  return (
    <div className="space-y-3">
      {/* Analyze Button */}
      {!suggestion && (
        <Button
          onClick={() => analyzeRoute(false)}
          disabled={isAnalyzing}
          size="sm"
          className="w-full bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700"
        >
          {isAnalyzing ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Analyzing Route...
            </>
          ) : (
            <>
              <Zap className="w-4 h-4 mr-2" />
              AI Route Optimization
            </>
          )}
        </Button>
      )}

      {/* Last Analysis Timestamp */}
      {lastAnalysis && !suggestion && !isAnalyzing && (
        <p className="text-xs text-slate-500 text-center">
          Last analyzed: {format(lastAnalysis, 'HH:mm')}
        </p>
      )}

      {/* Error Message */}
      {error && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700"
        >
          <AlertTriangle className="w-4 h-4 inline mr-2" />
          {error}
        </motion.div>
      )}

      {/* Suggestion Card */}
      <AnimatePresence>
        {suggestion && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
          >
            <Card className={`border-2 ${getUrgencyColor(suggestion.urgency_level)}`}>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between">
                  <CardTitle className="text-base font-semibold flex items-center gap-2">
                    <Zap className="w-5 h-5" />
                    Route Optimization Available
                  </CardTitle>
                  <Badge variant="secondary" className={getUrgencyColor(suggestion.urgency_level)}>
                    {suggestion.urgency_level} priority
                  </Badge>
                </div>
              </CardHeader>

              <CardContent className="space-y-3">
                {/* Time Savings */}
                <div className="flex items-center gap-2 p-3 bg-emerald-50 border border-emerald-200 rounded-lg">
                  <Clock className="w-5 h-5 text-emerald-600 flex-shrink-0" />
                  <div>
                    <p className="text-sm font-semibold text-emerald-900">
                      Save ~{suggestion.estimated_time_savings_minutes} minutes
                    </p>
                    <p className="text-xs text-emerald-700">
                      by optimizing your route order
                    </p>
                  </div>
                </div>

                {/* Reasoning */}
                <div className="space-y-2">
                  <p className="text-sm font-medium text-slate-700">AI Analysis:</p>
                  <p className="text-sm text-slate-600 leading-relaxed">
                    {suggestion.reasoning}
                  </p>
                </div>

                {/* Suggested Changes */}
                {suggestion.suggested_order && suggestion.suggested_order.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-sm font-medium text-slate-700">
                      Suggested Changes ({suggestion.suggested_order.length}):
                    </p>
                    <div className="space-y-1 max-h-40 overflow-y-auto">
                      {suggestion.suggested_order.slice(0, 5).map((change, idx) => {
                        if (!change || !change.delivery_id) return null; // CRITICAL FIX
                        
                        const delivery = (deliveries || []).find((deliveryItem) => deliveryItem && deliveryItem.id === change.delivery_id);
                        if (!delivery) return null;

                        const patient = (patients || []).find((p) => p && p.id === delivery.patient_id);
                        const store = (stores || []).find((s) => s && s.id === delivery.store_id);
                        const name = patient?.full_name || store?.name || 'Unknown';

                        return (
                          <div key={change.delivery_id} className="flex items-start gap-2 text-xs p-2 bg-slate-50 rounded">
                            <TrendingDown className="w-4 h-4 text-purple-600 flex-shrink-0 mt-0.5" />
                            <div className="flex-1 min-w-0">
                              <p className="font-medium text-slate-900">
                                {name}
                              </p>
                              <p className="text-slate-600">
                                Move to stop #{change.new_stop_order}
                              </p>
                              {change.reason && (
                                <p className="text-slate-500 italic mt-0.5">
                                  {change.reason}
                                </p>
                              )}
                            </div>
                          </div>
                        );
                      })}
                      {suggestion.suggested_order.length > 5 && (
                        <p className="text-xs text-slate-500 text-center py-1">
                          +{suggestion.suggested_order.length - 5} more changes
                        </p>
                      )}
                    </div>
                  </div>
                )}

                {/* Action Buttons */}
                <div className="flex gap-2 pt-2">
                  <Button
                    onClick={handleAccept}
                    className="flex-1 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700"
                    size="sm"
                  >
                    <CheckCircle className="w-4 h-4 mr-2" />
                    Accept & Optimize
                  </Button>
                  <Button
                    onClick={handleDismiss}
                    variant="outline"
                    size="sm"
                  >
                    <XCircle className="w-4 h-4 mr-2" />
                    Dismiss
                  </Button>
                </div>

                {suggestion.isAutomatic && (
                  <p className="text-xs text-slate-500 text-center">
                    💡 This suggestion was generated automatically
                  </p>
                )}
              </CardContent>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}