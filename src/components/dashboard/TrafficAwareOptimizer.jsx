import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { base44 } from '@/api/base44Client';
import { 
  Navigation, 
  Zap, 
  AlertTriangle, 
  TrendingUp, 
  Clock,
  MapPin,
  Loader2
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

export default function TrafficAwareOptimizer({ 
  driverId, 
  deliveryDate, 
  currentLocation,
  onOptimizationComplete 
}) {
  const [isOptimizing, setIsOptimizing] = useState(false);
  const [result, setResult] = useState(null);
  const [autoOptimizeTimer, setAutoOptimizeTimer] = useState(null);

  // Auto-optimize every 15 minutes when driver is on duty
  useEffect(() => {
    if (!driverId || !deliveryDate) return;

    const runAutoOptimize = async () => {
      try {
        await performOptimization('auto_check');
      } catch (error) {
        console.warn('Auto-optimize failed:', error);
      }
    };

    // Initial check after 2 minutes
    const initialTimer = setTimeout(runAutoOptimize, 120000);
    
    // Then check every 15 minutes
    const interval = setInterval(runAutoOptimize, 900000);

    return () => {
      clearTimeout(initialTimer);
      clearInterval(interval);
    };
  }, [driverId, deliveryDate]);

  const performOptimization = async (trigger = 'manual') => {
    setIsOptimizing(true);
    setResult(null);

    try {
      const response = await base44.functions.invoke('aiRouteOptimizer', {
        driverId,
        deliveryDate,
        currentLocation,
        trigger,
        enableAIAnalysis: true
      });

      const data = response?.data || response;
      setResult(data);

      if (onOptimizationComplete) {
        onOptimizationComplete(data);
      }
    } catch (error) {
      console.error('Optimization failed:', error);
      setResult({ 
        error: error.message,
        success: false 
      });
    } finally {
      setIsOptimizing(false);
    }
  };

  const getTrafficBadgeColor = (condition) => {
    const colors = {
      light: 'bg-green-100 text-green-800',
      normal: 'bg-blue-100 text-blue-800',
      moderate: 'bg-yellow-100 text-yellow-800',
      heavy: 'bg-orange-100 text-orange-800',
      severe: 'bg-red-100 text-red-800'
    };
    return colors[condition] || colors.normal;
  };

  return (
    <div className="space-y-4">
      <Card className="border-emerald-200 bg-gradient-to-br from-emerald-50 to-blue-50">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Zap className="w-5 h-5 text-emerald-600" />
            AI Route Optimizer
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button 
            onClick={() => performOptimization('manual')}
            disabled={isOptimizing}
            className="w-full gap-2"
          >
            {isOptimizing ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Optimizing Route...
              </>
            ) : (
              <>
                <Navigation className="w-4 h-4" />
                Optimize with Real-Time Traffic
              </>
            )}
          </Button>

          <AnimatePresence>
            {result && (
              <motion.div
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="space-y-3"
              >
                {result.success && (
                  <>
                    {/* Traffic Conditions */}
                    {result.trafficConditions && (
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-slate-700">Traffic Conditions:</span>
                        <Badge className={getTrafficBadgeColor(result.trafficConditions)}>
                          {result.trafficConditions.toUpperCase()}
                        </Badge>
                      </div>
                    )}

                    {/* AI Suggestions */}
                    {result.aiSuggestions?.prioritySuggestion && (
                      <Alert className="bg-blue-50 border-blue-200">
                        <TrendingUp className="w-4 h-4 text-blue-600" />
                        <AlertDescription className="text-sm text-blue-900">
                          <strong>AI Suggestion:</strong> {result.aiSuggestions.prioritySuggestion}
                        </AlertDescription>
                      </Alert>
                    )}

                    {/* Time-Sensitive Alerts */}
                    {result.aiSuggestions?.alerts?.length > 0 && (
                      <Alert className="bg-orange-50 border-orange-200">
                        <AlertTriangle className="w-4 h-4 text-orange-600" />
                        <AlertDescription className="space-y-1">
                          {result.aiSuggestions.alerts.map((alert, idx) => (
                            <div key={idx} className="text-sm text-orange-900">
                              • {alert}
                            </div>
                          ))}
                        </AlertDescription>
                      </Alert>
                    )}

                    {/* Route Summary */}
                    <div className="bg-white rounded-lg p-3 border border-slate-200 space-y-2">
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-slate-600">Stops Optimized:</span>
                        <span className="font-semibold text-slate-900">{result.updates?.length || 0}</span>
                      </div>
                      
                      {result.estimatedCompletionTime && (
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-slate-600">Est. Completion:</span>
                          <span className="font-semibold text-slate-900 flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {result.estimatedCompletionTime}
                          </span>
                        </div>
                      )}
                      
                      {result.polylineGenerated && (
                        <div className="flex items-center gap-2 text-xs text-emerald-600">
                          <MapPin className="w-3 h-3" />
                          Real-time route displayed on map
                        </div>
                      )}
                    </div>

                    {/* Notification Preview */}
                    {result.notification && (
                      <div className="bg-gradient-to-r from-emerald-500 to-blue-500 rounded-lg p-3 text-white">
                        <div className="font-semibold text-sm mb-1">{result.notification.title}</div>
                        <div className="text-xs opacity-90">{result.notification.message}</div>
                      </div>
                    )}
                  </>
                )}

                {result.error && (
                  <Alert className="bg-red-50 border-red-200">
                    <AlertTriangle className="w-4 h-4 text-red-600" />
                    <AlertDescription className="text-sm text-red-900">
                      Optimization failed: {result.error}
                    </AlertDescription>
                  </Alert>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </CardContent>
      </Card>
    </div>
  );
}