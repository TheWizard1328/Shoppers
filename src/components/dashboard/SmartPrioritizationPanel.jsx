import React, { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { 
  Brain, 
  AlertTriangle, 
  Clock, 
  MapPin, 
  TrendingUp, 
  RefreshCw, 
  ChevronDown, 
  ChevronUp,
  Thermometer,
  PenTool,
  DollarSign,
  Navigation,
  Zap,
  Car
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { format } from 'date-fns';

export default function SmartPrioritizationPanel({ 
  driverId, 
  deliveryDate, 
  currentUser,
  onApplySuggestion,
  compact = false 
}) {
  const [analysis, setAnalysis] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isExpanded, setIsExpanded] = useState(!compact);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [error, setError] = useState(null);

  const fetchAnalysis = useCallback(async (silent = false) => {
    if (!driverId || driverId === 'all' || !deliveryDate) return;

    if (!silent) setIsLoading(true);
    setError(null);

    try {
      // Get current local time in HH:mm format
      const now = new Date();
      const localTimeString = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      
      const response = await base44.functions.invoke('aiDeliveryPrioritization', {
        driverId,
        deliveryDate,
        currentLocalTime: localTimeString
      });

      const data = response?.data || response;
      
      if (data?.success) {
        setAnalysis(data);
        setLastUpdated(new Date());
      } else if (data?.error) {
        setError(data.error);
      }
    } catch (err) {
      console.error('AI Prioritization error:', err);
      setError(err.message || 'Failed to analyze deliveries');
    } finally {
      setIsLoading(false);
    }
  }, [driverId, deliveryDate]);

  useEffect(() => {
    fetchAnalysis();
    
    // Auto-refresh every 5 minutes
    const interval = setInterval(() => fetchAnalysis(true), 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [fetchAnalysis]);

  const handleApplySuggestion = async (suggestion) => {
    if (onApplySuggestion) {
      await onApplySuggestion(suggestion);
      // Refresh after applying
      setTimeout(() => fetchAnalysis(true), 1000);
    }
  };

  const getSeverityColor = (severity) => {
    switch (severity) {
      case 'critical': return 'bg-red-100 text-red-800 border-red-200';
      case 'warning': return 'bg-amber-100 text-amber-800 border-amber-200';
      case 'info': return 'bg-blue-100 text-blue-800 border-blue-200';
      default: return 'bg-slate-100 text-slate-800 border-slate-200';
    }
  };

  const getUrgencyColor = (score) => {
    if (score >= 80) return 'text-red-600';
    if (score >= 50) return 'text-amber-600';
    if (score >= 25) return 'text-blue-600';
    return 'text-slate-600';
  };

  const getUrgencyBg = (score) => {
    // Return inline style object for dark mode compatibility
    if (score >= 80) return { background: 'rgba(254, 226, 226, 0.5)' }; // red-50
    if (score >= 50) return { background: 'rgba(254, 243, 199, 0.5)' }; // amber-50
    if (score >= 25) return { background: 'rgba(219, 234, 254, 0.5)' }; // blue-50
    return { background: 'var(--bg-slate-100)' };
  };

  if (!driverId || driverId === 'all') {
    return null;
  }

  return (
    <Card className="border-2 border-purple-200 shadow-lg" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-purple-100 flex items-center justify-center">
              <Brain className="w-5 h-5 text-purple-600" />
            </div>
            <div>
              <CardTitle className="text-base font-bold" style={{ color: 'var(--text-slate-900)' }}>
                Smart Prioritization
              </CardTitle>
              {lastUpdated && (
                <p className="text-xs" style={{ color: 'var(--text-slate-500)' }}>
                  Updated {format(lastUpdated, 'HH:mm')}
                </p>
              )}
            </div>
          </div>
          
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => fetchAnalysis()}
              disabled={isLoading}
              className="h-8 w-8 p-0"
            >
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
            </Button>
            {compact && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setIsExpanded(!isExpanded)}
                className="h-8 w-8 p-0"
              >
                {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              </Button>
            )}
          </div>
        </div>
      </CardHeader>

      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
          >
            <CardContent className="pt-2">
              {error && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-lg mb-4">
                  <p className="text-sm text-red-700">{error}</p>
                </div>
              )}

              {isLoading && !analysis && (
                <div className="flex items-center justify-center py-8">
                  <RefreshCw className="w-6 h-6 animate-spin text-purple-500" />
                  <span className="ml-2 text-sm" style={{ color: 'var(--text-slate-600)' }}>
                    Analyzing deliveries...
                  </span>
                </div>
              )}

              {analysis && (
                <div className="space-y-4">
                  {/* Summary Stats */}
                  <div className="grid grid-cols-3 gap-2">
                    <div className="p-2 rounded-lg text-center" style={{ background: 'var(--bg-slate-100)' }}>
                      <div className="text-lg font-bold" style={{ color: 'var(--text-slate-900)' }}>
                        {analysis.summary?.totalActive || 0}
                      </div>
                      <div className="text-xs" style={{ color: 'var(--text-slate-500)' }}>Active</div>
                    </div>
                    <div className="p-2 bg-amber-50 rounded-lg text-center">
                      <div className="text-lg font-bold text-amber-700">
                        {analysis.summary?.urgentCount || 0}
                      </div>
                      <div className="text-xs text-amber-600">Urgent</div>
                    </div>
                    <div className="p-2 bg-red-50 rounded-lg text-center">
                      <div className="text-lg font-bold text-red-700">
                        {analysis.summary?.atRiskCount || 0}
                      </div>
                      <div className="text-xs text-red-600">At Risk</div>
                    </div>
                  </div>

                  {/* Traffic Conditions */}
                  {analysis.trafficConditions && (
                    <div className={`p-3 rounded-lg border ${
                      analysis.trafficConditions.congestionLevel === 'heavy' 
                        ? 'bg-red-50 border-red-200' 
                        : analysis.trafficConditions.congestionLevel === 'moderate'
                        ? 'bg-amber-50 border-amber-200'
                        : 'bg-green-50 border-green-200'
                    }`}>
                      <div className="flex items-center gap-2">
                        <Car className={`w-4 h-4 ${
                          analysis.trafficConditions.congestionLevel === 'heavy' 
                            ? 'text-red-600' 
                            : analysis.trafficConditions.congestionLevel === 'moderate'
                            ? 'text-amber-600'
                            : 'text-green-600'
                        }`} />
                        <span className="text-sm font-medium">
                          Traffic to next stop: {analysis.trafficConditions.congestionLevel}
                        </span>
                        {analysis.trafficConditions.delayMinutes > 0 && (
                          <Badge variant="outline" className="ml-auto">
                            +{analysis.trafficConditions.delayMinutes} min delay
                          </Badge>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Alerts */}
                  {analysis.alerts && analysis.alerts.length > 0 && (
                    <div className="space-y-2">
                      <h4 className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-slate-500)' }}>
                        Alerts
                      </h4>
                      {analysis.alerts.slice(0, 3).map((alert, idx) => (
                        <div key={idx} className={`p-2 rounded-lg border ${getSeverityColor(alert.severity)}`}>
                          <div className="flex items-start gap-2">
                            <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>{alert.message}</p>
                              {alert.patientName && (
                                <p className="text-xs opacity-75" style={{ color: 'var(--text-slate-600)' }}>{alert.patientName}</p>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Suggestions */}
                  {analysis.suggestions && analysis.suggestions.length > 0 && (
                    <div className="space-y-2">
                      <h4 className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-slate-500)' }}>
                        Recommendations
                      </h4>
                      {analysis.suggestions.map((suggestion, idx) => (
                        <div key={idx} className="p-3 border rounded-lg" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                          <div className="flex items-start gap-2">
                            <Zap className="w-4 h-4 text-purple-600 flex-shrink-0 mt-0.5" />
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>{suggestion.title}</p>
                              <p className="text-xs mt-0.5" style={{ color: 'var(--text-slate-700)' }}>{suggestion.description}</p>
                              {suggestion.reasoning && (
                                <p className="text-xs mt-1 opacity-75" style={{ color: 'var(--text-slate-600)' }}>{suggestion.reasoning}</p>
                              )}
                              {suggestion.action && onApplySuggestion && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="mt-2 h-7 text-xs border-purple-300 text-purple-700 hover:bg-purple-100"
                                  onClick={() => handleApplySuggestion(suggestion)}
                                >
                                  Apply Suggestion
                                </Button>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Top Priority Deliveries */}
                  {analysis.deliveryAnalysis && analysis.deliveryAnalysis.length > 0 && (
                    <div className="space-y-2">
                      <h4 className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-slate-500)' }}>
                        Priority Ranking
                      </h4>
                      <div className="space-y-1 max-h-[200px] overflow-y-auto">
                        {analysis.deliveryAnalysis.slice(0, 5).map((delivery, idx) => (
                          <div 
                            key={delivery.deliveryId}
                            className="p-2 rounded-lg border"
                            style={{ borderColor: 'var(--border-slate-300)', ...getUrgencyBg(delivery.urgencyScore) }}
                          >
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2 min-w-0 flex-1">
                                <span className={`text-xs font-bold ${getUrgencyColor(delivery.urgencyScore)}`}>
                                  #{idx + 1}
                                </span>
                                <span className="text-sm font-medium truncate" style={{ color: 'var(--text-slate-900)' }}>
                                  {delivery.patientName}
                                </span>
                                <div className="flex items-center gap-1 flex-shrink-0">
                                  {delivery.isFridge && <Thermometer className="w-3 h-3 text-blue-500" />}
                                  {delivery.isSignature && <PenTool className="w-3 h-3 text-amber-500" />}
                                  {delivery.isCOD && <DollarSign className="w-3 h-3 text-green-500" />}
                                </div>
                              </div>
                              <Badge 
                                variant="outline" 
                                className={`ml-2 text-xs ${getUrgencyColor(delivery.urgencyScore)}`}
                                style={{ borderColor: 'var(--border-slate-300)' }}
                              >
                                {delivery.urgencyScore}%
                              </Badge>
                            </div>
                            <div className="flex items-center gap-3 mt-1 text-xs" style={{ color: 'var(--text-slate-500)' }}>
                              {delivery.timeWindowEnd && (
                                <span className="flex items-center gap-1">
                                  <Clock className="w-3 h-3" />
                                  by {delivery.timeWindowEnd}
                                </span>
                              )}
                              {delivery.distanceKm !== null && (
                                <span className="flex items-center gap-1">
                                  <MapPin className="w-3 h-3" />
                                  {delivery.distanceKm} km
                                </span>
                              )}
                              {delivery.estimatedTravelMinutes && (
                                <span className="flex items-center gap-1">
                                  <Navigation className="w-3 h-3" />
                                  ~{delivery.estimatedTravelMinutes} min
                                </span>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* No issues */}
                  {(!analysis.alerts || analysis.alerts.length === 0) && 
                   (!analysis.suggestions || analysis.suggestions.length === 0) && (
                    <div className="text-center py-4">
                      <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-2">
                        <TrendingUp className="w-6 h-6 text-green-600" />
                      </div>
                      <p className="text-sm font-medium text-green-700">Route looks optimal!</p>
                      <p className="text-xs text-green-600">No urgent issues detected</p>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </motion.div>
        )}
      </AnimatePresence>
    </Card>
  );
}