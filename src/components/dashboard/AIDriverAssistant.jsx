import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { motion, AnimatePresence } from "framer-motion";
import { 
  Bot, 
  Send, 
  Loader2, 
  ThumbsUp, 
  ThumbsDown, 
  AlertTriangle, 
  Navigation, 
  Clock,
  CloudRain,
  MapPin,
  TrendingUp,
  X,
  Sparkles,
  ChevronDown,
  ChevronUp,
  Zap,
  CheckCircle,
  Circle,
  Snowflake // NEW: Icon for fridge items
} from "lucide-react";
import { base44 } from "@/api/base44Client";
import { format } from "date-fns";
import { getRouteOptimizationSettings } from "./RouteOptimizationSettings";
import { calculateRouteStats } from "../utils/routeOptimizer";

// Message component with feedback
const AssistantMessage = ({ message, onFeedback }) => {
  const [feedbackGiven, setFeedbackGiven] = useState(message.feedback || null);

  const handleFeedback = async (feedback) => {
    setFeedbackGiven(feedback);
    if (onFeedback) {
      await onFeedback(message.id, feedback);
    }
  };

  const getIcon = () => {
    switch (message.type) {
      case 'reroute':
        return <Navigation className="w-4 h-4 text-blue-600" />;
      case 'delay_warning':
        return <Clock className="w-4 h-4 text-amber-600" />;
      case 'traffic_alert':
        return <AlertTriangle className="w-4 h-4 text-red-600" />;
      case 'weather_alert':
        return <CloudRain className="w-4 h-4 text-slate-600" />;
      case 'prioritize':
        return <TrendingUp className="w-4 h-4 text-emerald-600" />;
      case 'fridge_alert': // NEW: Fridge item alert
        return <Snowflake className="w-4 h-4 text-cyan-600" />;
      default:
        return <Sparkles className="w-4 h-4 text-purple-600" />;
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className={`flex gap-3 ${message.role === 'user' ? 'justify-end' : ''}`}>
      
      {message.role === 'assistant' && (
        <div className="flex-shrink-0 w-8 h-8 rounded-full bg-gradient-to-br from-purple-500 to-blue-600 flex items-center justify-center shadow-lg">
          <Bot className="w-5 h-5 text-white" />
        </div>
      )}

      <div className={`flex-1 max-w-[85%] ${message.role === 'user' ? 'flex justify-end' : ''}`}>
        <div className={`rounded-2xl p-3 ${
          message.role === 'user' 
            ? 'bg-blue-600 text-white ml-auto' 
            : 'bg-white border border-slate-200 shadow-sm'
        }`}>
          
          {message.role === 'assistant' && message.type && (
            <div className="flex items-center gap-2 mb-2">
              {getIcon()}
              <Badge variant="outline" className="text-xs capitalize">
                {message.type.replace('_', ' ')}
              </Badge>
              {message.priority === 'high' && (
                <Badge className="text-xs bg-red-100 text-red-700 border-red-300">
                  Urgent
                </Badge>
              )}
            </div>
          )}

          <div className="text-sm leading-relaxed whitespace-pre-wrap">
            {message.content}
          </div>

          {message.role === 'assistant' && message.actionable && (
            <div className="mt-3 pt-3 border-t border-slate-100 flex items-center gap-2">
              <span className="text-xs text-slate-500">Was this helpful?</span>
              <Button
                variant={feedbackGiven === 'helpful' ? 'default' : 'ghost'}
                size="sm"
                className={`h-7 px-2 ${feedbackGiven === 'helpful' ? 'bg-emerald-600' : ''}`}
                onClick={() => handleFeedback('helpful')}>
                <ThumbsUp className="w-3 h-3" />
              </Button>
              <Button
                variant={feedbackGiven === 'not_helpful' ? 'default' : 'ghost'}
                size="sm"
                className={`h-7 px-2 ${feedbackGiven === 'not_helpful' ? 'bg-red-600' : ''}`}
                onClick={() => handleFeedback('not_helpful')}>
                <ThumbsDown className="w-3 h-3" />
              </Button>
            </div>
          )}

          {message.timestamp && (
            <p className={`text-xs mt-2 ${
              message.role === 'user' ? 'text-blue-100' : 'text-slate-400'
            }`}>
              {format(new Date(message.timestamp), 'HH:mm')}
            </p>
          )}
        </div>
      </div>

      {message.role === 'user' && (
        <div className="flex-shrink-0 w-8 h-8 rounded-full bg-gradient-to-br from-slate-400 to-slate-600 flex items-center justify-center text-white text-sm font-bold shadow-lg">
          {message.driverInitial || 'D'}
        </div>
      )}
    </motion.div>
  );
};

export default function AIDriverAssistant({ 
  currentUser, 
  deliveries = [], 
  patients = [],
  stores = [],
  drivers = [],
  currentLocation = null,
  selectedDate,
  onClose
}) {
  const [messages, setMessages] = useState([]);
  const [inputMessage, setInputMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const [hasCheckedAlerts, setHasCheckedAlerts] = useState(false);
  const messagesEndRef = useRef(null);
  const sessionIdRef = useRef(`session-${Date.now()}`);
  const alertCheckIntervalRef = useRef(null);
  const containerRef = useRef(null); // NEW: For click-outside detection

  // NEW: Handle click outside to close
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (containerRef.current && !containerRef.current.contains(event.target)) {
        // Only close if not minimized on desktop, or always close on mobile
        if (!isMinimized || window.innerWidth < 1024) { // 1024px is default lg breakpoint
          onClose();
        }
      }
    };

    // Add event listener
    document.addEventListener('mousedown', handleClickOutside);
    
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [onClose, isMinimized]);

  // Scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Welcome message on mount
  useEffect(() => {
    const welcomeMessage = {
      id: 'welcome',
      role: 'assistant',
      type: 'general_advice',
      content: `Hi ${currentUser?.user_name?.split(' ')[0] || 'there'}! 👋\n\nI'm your AI delivery assistant with live traffic monitoring. I can help you:\n\n🚦 Real-time traffic analysis & delay predictions\n📍 Multi-stop clustering for efficient groupings\n⏰ Time window monitoring with traffic awareness\n🌤️ Weather impact assessment\n❄️ Refrigerated item tracking\n🎯 Smart route reordering suggestions\n\nI'll proactively alert you to traffic delays, clustering opportunities, and critical issues. How can I help optimize your route?`,
      timestamp: new Date().toISOString(),
      actionable: false
    };

    setMessages([welcomeMessage]);

    // Initial proactive check after 2 seconds
    setTimeout(() => {
      checkForProactiveAlerts();
    }, 2000);

    // Set up periodic alert checking (every 5 minutes)
    alertCheckIntervalRef.current = setInterval(() => {
      checkForProactiveAlerts();
    }, 5 * 60 * 1000);

    return () => {
      if (alertCheckIntervalRef.current) {
        clearInterval(alertCheckIntervalRef.current);
      }
    };
  }, []);

  // Proactive alerts with AI analysis
  const checkForProactiveAlerts = useCallback(async () => {
    if (!currentUser || deliveries.length === 0 || isLoading) return;

    try {
      const activeDeliveries = deliveries.filter(d => 
        !['completed', 'failed', 'cancelled', 'returned'].includes(d.status)
      );

      if (activeDeliveries.length === 0) return;

      console.log('🤖 [AI Assistant] Checking for proactive alerts...');

      // Build comprehensive context for AI analysis
      const context = buildAIContext(true);
      
      // Get past feedback to learn from
      const pastFeedback = await base44.entities.DriverAssistantFeedback.filter({
        driver_id: currentUser.id
      });

      const helpfulSuggestions = pastFeedback.filter(f => 
        f.driver_feedback === 'helpful' || f.driver_feedback === 'followed'
      );

      const learningContext = helpfulSuggestions.length > 0
        ? `\n\nPAST SUCCESSFUL SUGGESTIONS (learn from these):\n${helpfulSuggestions.slice(-5).map(f => 
            `- ${f.suggestion_type}: "${f.suggestion_text}"`
          ).join('\n')}`
        : '';

      const prompt = `You are a proactive AI delivery assistant with real-time traffic and weather monitoring capabilities.

CURRENT ROUTE DATA:
${JSON.stringify(context, null, 2)}

${learningContext}

YOUR MISSION: Provide the MOST CRITICAL proactive alert using live traffic and weather data.

ADVANCED ANALYSIS REQUIRED:
1. **LIVE TRAFFIC ANALYSIS** - Use real-time traffic data to:
   - Identify current congestion on routes between stops
   - Predict traffic delays based on time of day and current conditions
   - Calculate actual travel times with traffic (not just distance-based estimates)
   - Suggest route reordering to avoid traffic hotspots
   - Identify if rescheduling stops to avoid rush hour would save significant time

2. **MULTI-STOP CLUSTERING** - Identify efficient groupings:
   - Find clusters of 2-4 nearby stops (within 1-2km) that should be completed together
   - Suggest visiting clustered stops before moving to distant areas
   - Calculate time savings from intelligent clustering
   - Recommend "sweep patterns" for dense neighborhoods

3. **PREDICTIVE DELAY DETECTION**:
   - Forecast delays based on current traffic trends
   - Warn about upcoming rush hours that will impact remaining stops
   - Identify stops that will become harder to reach later in the day
   - Suggest time-sensitive stops to complete NOW before traffic worsens

4. **TIME WINDOW OPTIMIZATION**:
   - CRITICAL: A delivery is "on time" if its ETA is AT or AFTER the time_window_start AND AT or BEFORE the time_window_end (deadline)
   - A delivery is only "AFTER its time window" if the ETA is LATER than the time_window_end (deadline)
   - If ETA equals the time_window_start, the delivery is ON TIME, not late
   - Factor in REAL traffic conditions, not just distance
   - Suggest which stops to prioritize based on deadline + traffic

5. **WEATHER IMPACT ANALYSIS**:
   - Check current weather conditions at delivery locations
   - Warn about rain, snow, or extreme temperatures affecting deliveries
   - Prioritize weather-sensitive items (fridge items in heat, packages in rain)

6. **REFRIGERATED ITEMS - CRITICAL**:
   - Track time out of refrigeration (>90 min = critical)
   - Factor in ambient temperature from weather data
   - URGENT priority if fridge items + hot weather + long route time

RESPONSE REQUIREMENTS:
- Use LIVE traffic data to give accurate delay predictions
- When suggesting route changes, include: "Based on current traffic, reorder Stop #X before Stop #Y to save [minutes] and avoid [specific traffic issue]"
- For clustering: "Stops #A, #B, #C are within 1.5km - complete these together to save [minutes]"
- Be SPECIFIC: Use actual stop numbers, patient names, locations, and time savings
- Keep under 120 words but be detailed about reasoning
- If no critical issues: respond "NO_ALERT"

PRIORITY LEVELS (only alert on HIGH/MEDIUM):
- HIGH: Time violations (<30min) OR fridge risk OR major traffic delays predicted (>20min)
- MEDIUM: Clustering opportunities OR efficiency improvements (>10min savings)
- LOW: General tips (do not send)`;

      const response = await base44.integrations.Core.InvokeLLM({
        prompt: prompt,
        add_context_from_internet: true // Get real-time traffic/weather
      });

      if (response && response !== 'NO_ALERT' && !response.includes('NO_ALERT')) {
        const suggestionType = detectSuggestionType(response);
        const priority = detectPriority(response);

        const alertMessage = {
          id: `alert-${Date.now()}`,
          role: 'assistant',
          type: suggestionType,
          priority: priority,
          content: `🚨 ${response}`,
          timestamp: new Date().toISOString(),
          actionable: true
        };

        setMessages(prev => [...prev, alertMessage]);

        // Store for learning
        await storeFeedbackContext(suggestionType, response, context);

        console.log('✅ [AI Assistant] Proactive alert generated:', suggestionType);
      } else {
        console.log('✓ [AI Assistant] No critical alerts needed');
      }

      setHasCheckedAlerts(true);

    } catch (error) {
      console.error('Error checking proactive alerts:', error);
    }
  }, [currentUser, deliveries, currentLocation, isLoading]);

  // Detect priority from message
  const detectPriority = (message) => {
    const lower = message.toLowerCase();
    // NEW: Fridge items are always high priority
    if (lower.includes('fridge') || lower.includes('refrigerat') || lower.includes('cold') || lower.includes('spoil')) {
      return 'high';
    }
    if (lower.includes('urgent') || lower.includes('immediate') || lower.includes('critical')) {
      return 'high';
    }
    if (lower.includes('soon') || lower.includes('recommend') || lower.includes('suggest')) {
      return 'medium';
    }
    return 'low';
  };

  // Calculate time until deadline
  const calculateTimeUntil = (currentTime, targetTime) => {
    const [currentHours, currentMinutes] = currentTime.split(':').map(Number);
    const [targetHours, targetMinutes] = targetTime.split(':').map(Number);
    
    const currentTotalMinutes = currentHours * 60 + currentMinutes;
    const targetTotalMinutes = targetHours * 60 + targetMinutes;
    
    return targetTotalMinutes - currentTotalMinutes;
  };

  // Find nearby stops
  const findNearbyStops = (location, stops) => {
    const NEARBY_THRESHOLD_KM = 2;
    
    return stops.filter(delivery => {
      let stopLat, stopLon;
      
      if (delivery.patient_id) {
        const patient = patients.find(p => p.id === delivery.patient_id);
        if (!patient?.latitude || !patient?.longitude) return false;
        stopLat = patient.latitude;
        stopLon = patient.longitude;
      } else {
        const store = stores.find(s => s.id === delivery.store_id);
        if (!store?.latitude || !store?.longitude) return false;
        stopLat = store.latitude;
        stopLon = store.longitude;
      }

      const distance = calculateDistance(
        location.latitude,
        location.longitude,
        stopLat,
        stopLon
      );

      return distance <= NEARBY_THRESHOLD_KM;
    });
  };

  // Haversine distance calculation
  const calculateDistance = (lat1, lon1, lat2, lon2) => {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  };

  // Build comprehensive AI context
  const buildAIContext = useCallback((includeDetailed = false) => {
    const activeDeliveries = deliveries.filter(d => 
      !['completed', 'failed', 'cancelled', 'returned'].includes(d.status)
    );

    const completedToday = deliveries.filter(d => 
      d.status === 'completed' && d.delivery_date === format(selectedDate, 'yyyy-MM-dd')
    );

    const settings = getRouteOptimizationSettings();
    
    const routeStats = activeDeliveries.length > 0 
      ? calculateRouteStats(activeDeliveries, stores, patients)
      : null;

    const now = new Date();
    const currentTime = format(now, 'HH:mm');

    // Identify urgent deliveries
    const urgentDeliveries = activeDeliveries.filter(d => {
      if (!d.delivery_time_end) return false;
      const timeUntil = calculateTimeUntil(currentTime, d.delivery_time_end);
      return timeUntil > 0 && timeUntil < 60;
    }).map(d => {
      const patient = patients.find(p => p.id === d.patient_id);
      return {
        stop_number: d.stop_order,
        patient_name: patient?.full_name,
        deadline: d.delivery_time_end,
        minutes_remaining: calculateTimeUntil(currentTime, d.delivery_time_end)
      };
    });

    // NEW: Identify fridge items and their status
    const fridgeDeliveries = activeDeliveries.filter(d => d.fridge_item).map(d => {
      const patient = patients.find(p => p.id === d.patient_id);
      const pickupTime = d.delivery_time_start; // Time picked up from store
      const minutesOutOfFridge = pickupTime 
        ? calculateTimeUntil(pickupTime, currentTime)
        : 0;
      
      return {
        stop_number: d.stop_order,
        patient_name: patient?.full_name,
        status: d.status,
        scheduled_time: d.delivery_time_start,
        eta: d.delivery_time_eta,
        minutes_out_of_fridge: minutesOutOfFridge,
        is_critical: minutesOutOfFridge > 90 // Over 90 minutes is critical
      };
    });

    // NEW: Identify potential multi-stop clusters
    const identifyStopClusters = () => {
      const clusters = [];
      const processed = new Set();
      const CLUSTER_DISTANCE_KM = 1.5; // Stops within 1.5km are clusterable
      
      activeDeliveries.forEach((stop, index) => {
        if (processed.has(stop.id)) return;
        
        const patient = patients.find(p => p.id === stop.patient_id);
        const store = stores.find(s => s.id === stop.store_id);
        const stopLat = patient?.latitude || store?.latitude;
        const stopLon = patient?.longitude || store?.longitude;
        
        if (!stopLat || !stopLon) return;
        
        // Find nearby stops
        const nearbyStops = activeDeliveries.filter((otherStop, otherIndex) => {
          if (otherIndex === index || processed.has(otherStop.id)) return false;
          
          const otherPatient = patients.find(p => p.id === otherStop.patient_id);
          const otherStore = stores.find(s => s.id === otherStop.store_id);
          const otherLat = otherPatient?.latitude || otherStore?.latitude;
          const otherLon = otherPatient?.longitude || otherStore?.longitude;
          
          if (!otherLat || !otherLon) return false;
          
          const distance = calculateDistance(stopLat, stopLon, otherLat, otherLon);
          return distance <= CLUSTER_DISTANCE_KM;
        });
        
        if (nearbyStops.length > 0) {
          const clusterStops = [stop, ...nearbyStops];
          clusterStops.forEach(s => processed.add(s.id));
          
          clusters.push({
            stop_numbers: clusterStops.map(s => s.stop_order),
            stop_count: clusterStops.length,
            center_lat: stopLat,
            center_lon: stopLon,
            patient_names: clusterStops.map(s => {
              const p = patients.find(pt => pt.id === s.patient_id);
              return p?.full_name || 'Pickup';
            })
          });
        }
      });
      
      return clusters;
    };

    const stopClusters = identifyStopClusters();

    const baseContext = {
      driver: {
        name: currentUser?.user_name || currentUser?.full_name,
        id: currentUser?.id
      },
      route: {
        date: format(selectedDate, 'yyyy-MM-dd'),
        current_time: currentTime,
        total_stops: deliveries.length,
        active_stops: activeDeliveries.length,
        completed_stops: completedToday.length,
        remaining_distance_km: routeStats?.totalDistance || 0,
        estimated_time_remaining_minutes: routeStats?.totalTime || 0,
        urgent_deliveries: urgentDeliveries,
        // Enhanced: Fridge item tracking
        fridge_items: {
          total: fridgeDeliveries.length,
          critical: fridgeDeliveries.filter(f => f.is_critical).length,
          details: fridgeDeliveries
        },
        // NEW: Multi-stop clustering opportunities
        stop_clusters: {
          total_clusters: stopClusters.length,
          details: stopClusters
        }
      },
      location: currentLocation ? {
        latitude: currentLocation.latitude,
        longitude: currentLocation.longitude,
        timestamp: currentLocation.timestamp
      } : null,
      settings: {
        default_travel_time: settings.defaultTravelTimeMinutes,
        default_stop_time: settings.defaultStopTimeMinutes,
        prioritize_pickups: settings.prioritizePickups
      },
      // NEW: Request live traffic analysis
      traffic_analysis_requested: true,
      weather_check_requested: true
    };

    if (includeDetailed) {
      // Add detailed stop information for proactive analysis
      baseContext.stops_detail = activeDeliveries.map(d => {
        const patient = patients.find(p => p.id === d.patient_id);
        const store = stores.find(s => s.id === d.store_id);
        
        return {
          stop_number: d.stop_order,
          type: d.patient_id ? 'delivery' : 'pickup',
          patient_name: patient?.full_name,
          store_name: store?.name,
          scheduled_time: d.delivery_time_start,
          deadline: d.delivery_time_end,
          eta: d.delivery_time_eta,
          status: d.status,
          latitude: patient?.latitude || store?.latitude,
          longitude: patient?.longitude || store?.longitude,
          fridge_item: d.fridge_item || false, // NEW: Include fridge status
          signature_needed: d.signature_needed || false,
          oversized: d.oversized || false
        };
      }).filter(s => s.latitude && s.longitude);
    }

    return baseContext;
  }, [deliveries, currentUser, selectedDate, currentLocation, stores, patients]);

  // Send message to AI
  const handleSendMessage = async () => {
    if (!inputMessage.trim() || isLoading) return;

    const userMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: inputMessage,
      timestamp: new Date().toISOString(),
      driverInitial: currentUser?.user_name?.charAt(0) || 'D'
    };

    setMessages(prev => [...prev, userMessage]);
    setInputMessage('');
    setIsLoading(true);

    try {
      const context = buildAIContext(true);
      
      // Get past helpful feedback to improve suggestions
      const pastFeedback = await base44.entities.DriverAssistantFeedback.filter({
        driver_id: currentUser.id,
        driver_feedback: { $in: ['helpful', 'followed'] }
      });

      const learningInsights = pastFeedback.length > 0
        ? `\n\nLEARNING FROM PAST (driver found these helpful):\n${pastFeedback.slice(-3).map(f => 
            `- ${f.suggestion_type}: "${f.suggestion_text.substring(0, 100)}..."`
          ).join('\n')}`
        : '';

      // Get conversation history
      const conversationHistory = messages
        .slice(-8)
        .map(m => `${m.role === 'user' ? 'Driver' : 'AI Assistant'}: ${m.content}`)
        .join('\n');

      const prompt = `You are an expert AI delivery assistant with real-time traffic monitoring and route optimization capabilities helping ${currentUser?.user_name}.

LIVE ROUTE DATA:
${JSON.stringify(context, null, 2)}

${learningInsights}

CONVERSATION HISTORY:
${conversationHistory}

DRIVER'S QUESTION:
${inputMessage}

YOUR CAPABILITIES:
✓ Real-time traffic data access - check current conditions and predict delays
✓ Live weather monitoring - assess impact on deliveries
✓ Multi-stop clustering analysis - identify efficient groupings
✓ Predictive delay forecasting - anticipate problems before they occur
✓ Route resequencing - suggest optimal order changes with traffic awareness

RESPONSE GUIDELINES:
1. **USE LIVE TRAFFIC DATA**: 
   - Check actual current traffic conditions between stops
   - Predict delays based on time of day + live traffic
   - Calculate real travel times, not just distance-based estimates
   - Warn about upcoming rush hours or traffic events

2. **CLUSTERING INTELLIGENCE**:
   - Identify nearby stops (within 1-2km) that should be grouped
   - Suggest "neighborhood sweeps" - complete all nearby stops before moving on
   - Calculate time/fuel savings from clustering
   - Example: "Stops #5, #7, and #9 are all within 1.2km - complete these together to save 15 minutes"

3. **TRAFFIC-AWARE REROUTING**:
   - When suggesting route changes, include current traffic justification
   - Example: "Heavy traffic on Highway 2 right now (15min delay) - recommend taking Stop #8 before Stop #6 via alternate route, saving 12 minutes"

4. **PREDICTIVE ALERTS**:
   - "Based on traffic patterns, completing Stop #4 now will avoid 3pm rush hour"
   - "Weather forecast shows rain in 45 minutes - prioritize outdoor deliveries"
   - CRITICAL TIME WINDOW RULE: A delivery is "on time" if ETA >= time_window_start AND ETA <= time_window_end. Only flag as "after time window" if ETA > time_window_end.

5. **MULTI-STOP OPTIMIZATION**:
   - Group 2-4 stops when they're close together
   - Suggest completing clusters before moving to next area
   - Provide specific savings: "Grouping saves X minutes and Y kilometers"

6. **FRIDGE ITEMS - CRITICAL**:
   - Always check time out of refrigeration
   - Factor in current temperature from weather data
   - URGENT if >90min out + hot weather

FORMAT:
- Be specific: Stop numbers, patient names, distances, time savings
- Include reasoning: "Because [traffic/weather/clustering reason]..."
- Suggest actions: "I recommend..."
- Quantify benefits: "This will save X minutes and Y km"
- Be conversational but professional

Respond now with live data-backed suggestions:`;

      const response = await base44.integrations.Core.InvokeLLM({
        prompt: prompt,
        add_context_from_internet: true // Real-time traffic/weather data
      });

      const suggestionType = detectSuggestionType(response);
      const priority = detectPriority(response);

      const assistantMessage = {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        type: suggestionType,
        priority: priority,
        content: response,
        timestamp: new Date().toISOString(),
        actionable: true
      };

      setMessages(prev => [...prev, assistantMessage]);

      // Store interaction for learning
      await storeFeedbackContext(suggestionType, response, context);

    } catch (error) {
      console.error('Error getting AI response:', error);
      
      const errorMessage = {
        id: `error-${Date.now()}`,
        role: 'assistant',
        type: 'general_advice',
        content: "I'm having trouble processing that request. Please check your connection and try again.",
        timestamp: new Date().toISOString(),
        actionable: false
      };

      setMessages(prev => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
    }
  };

  // Detect suggestion type from AI response - ENHANCED
  const detectSuggestionType = (response) => {
    const lower = response.toLowerCase();
    
    // Priority 1: Fridge item suggestions (highest priority)
    if (lower.includes('fridge') || lower.includes('refrigerat') || lower.includes('cold') || lower.includes('spoil') || lower.includes('temperature')) {
      return 'fridge_alert';
    }
    
    // Priority 2: Traffic-based rerouting
    if (lower.includes('traffic') || lower.includes('congestion') || lower.includes('rush hour') || lower.includes('delay')) {
      if (lower.includes('reroute') || lower.includes('reorder') || lower.includes('visit') && lower.includes('before')) {
        return 'reroute'; // Traffic-based reroute
      }
      return 'traffic_alert'; // Traffic warning without route change
    }
    
    // Priority 3: Multi-stop clustering
    if (lower.includes('cluster') || lower.includes('group') || lower.includes('nearby') || lower.includes('together') || lower.includes('batch')) {
      return 'reroute'; // Clustering is a type of route optimization
    }
    
    // Priority 4: General route optimization
    if (lower.includes('reroute') || lower.includes('route change') || lower.includes('different order') || lower.includes('optimal order')) {
      return 'reroute';
    }
    
    // Priority 5: Urgency/Prioritization
    if (lower.includes('prioritize') || lower.includes('urgent') || lower.includes('first') || lower.includes('immediately')) {
      return 'prioritize';
    }
    
    // Priority 6: Time window alerts
    if (lower.includes('time window') || lower.includes('deadline') || lower.includes('minutes remaining') || lower.includes('late')) {
      return 'time_window_alert';
    }
    
    // Priority 7: Weather
    if (lower.includes('weather') || lower.includes('rain') || lower.includes('snow') || lower.includes('storm')) {
      return 'weather_alert';
    }
    
    return 'general_advice';
  };

  // Store feedback context for learning
  const storeFeedbackContext = async (suggestionType, suggestionText, context) => {
    try {
      await base44.entities.DriverAssistantFeedback.create({
        driver_id: currentUser.id,
        suggestion_type: suggestionType,
        suggestion_text: suggestionText,
        context: {
          delivery_date: context.route.date,
          stops_remaining: context.route.active_stops,
          current_location: context.location,
          fridge_items: context.route.fridge_items || {}, // NEW: Include fridge item context
          weather_conditions: 'checking', // Will be enhanced by AI
          traffic_level: 'moderate' // Will be enhanced by AI
        }
      });
    } catch (error) {
      console.error('Error storing feedback context:', error);
    }
  };

  // Handle feedback on message
  const handleFeedback = async (messageId, feedback) => {
    try {
      const message = messages.find(m => m.id === messageId);
      if (!message) return;

      // Update the feedback in the database
      const feedbackRecords = await base44.entities.DriverAssistantFeedback.filter({
        driver_id: currentUser.id,
        suggestion_text: message.content
      });

      if (feedbackRecords && feedbackRecords.length > 0) {
        await base44.entities.DriverAssistantFeedback.update(
          feedbackRecords[0].id,
          { driver_feedback: feedback }
        );

        console.log(`📊 [AI Assistant] Feedback recorded: ${feedback} for ${message.type}`);
      }

      // Update local state
      setMessages(prev => prev.map(m => 
        m.id === messageId ? { ...m, feedback } : m
      ));

      // Show acknowledgment
      if (feedback === 'helpful') {
        const thankYouMessage = {
          id: `thanks-${Date.now()}`,
          role: 'assistant',
          type: 'general_advice',
          content: "Thanks for the feedback! I'll remember what worked well for you. 👍",
          timestamp: new Date().toISOString(),
          actionable: false
        };
        
        setTimeout(() => {
          setMessages(prev => [...prev, thankYouMessage]);
        }, 500);
      }

    } catch (error) {
      console.error('Error recording feedback:', error);
    }
  };

  // Handle Enter key
  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  // Quick action handlers with enhanced traffic-aware prompts
  const handleQuickAction = (action) => {
    const actions = {
      optimize: "Analyze current traffic conditions and suggest the optimal order for my remaining stops. Include specific stop numbers and explain how traffic impacts the route. Identify any multi-stop clusters I should complete together.",
      urgency: "Check all my stops against their time windows using LIVE traffic data. Which ones are at risk due to current traffic delays? Prioritize by urgency and traffic conditions.",
      alerts: "Scan live traffic and weather data for my route. Report any congestion, accidents, road closures, or weather conditions that will impact my remaining deliveries. Include specific affected stops and suggested alternatives.",
      nearby: currentLocation 
        ? "Based on my current GPS location and live traffic, which stops are nearby and can be efficiently grouped together? Suggest a cluster sequence with time savings."
        : "Analyze my route and identify all multi-stop clusters (stops within 1-2km of each other). Suggest efficient groupings with estimated time and fuel savings for each cluster.",
      fridge: "URGENT: Check all refrigerated items on my route. Calculate time out of refrigeration, check current temperature, and tell me which ones need immediate priority. Include stop numbers and risk level for each." // Enhanced fridge action
    };

    setInputMessage(actions[action]);
    // Auto-send after a brief delay
    setTimeout(() => {
      handleSendMessage();
    }, 100);
  };

  // NEW: Calculate fridge item stats for badge
  const fridgeItemStats = useMemo(() => {
    const activeDeliveries = deliveries.filter(d => 
      !['completed', 'failed', 'cancelled', 'returned'].includes(d.status)
    );
    
    const fridgeItems = activeDeliveries.filter(d => d.fridge_item);
    const now = new Date();
    const currentTime = format(now, 'HH:mm');
    
    const criticalCount = fridgeItems.filter(d => {
      const pickupTime = d.delivery_time_start;
      if (!pickupTime) return false;
      const minutesOut = calculateTimeUntil(pickupTime, currentTime);
      return minutesOut > 90;
    }).length;

    return {
      total: fridgeItems.length,
      critical: criticalCount
    };
  }, [deliveries, selectedDate]);

  return (
    <>
      {/* NEW: Backdrop overlay for mobile, only shows when not minimized and on screens smaller than lg */}
      {!isMinimized && (
        <div 
          className="fixed inset-0 bg-black/40 z-[9998] lg:hidden"
          onClick={onClose}
        />
      )}

      {/* AI Panel - RESPONSIVE */}
      <motion.div
        ref={containerRef}
        initial={{ opacity: 0, scale: 0.9, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.9, y: 20 }}
        className={`fixed z-[9999] shadow-2xl
          ${isMinimized 
            ? 'bottom-4 right-4 w-80' 
            : 'inset-4 lg:inset-auto lg:bottom-4 lg:right-4 lg:w-[400px]'
          }
        `}>
        
        <Card className="border-2 border-purple-200 bg-white h-full flex flex-col">
          <CardHeader className="p-4 border-b border-slate-200 bg-gradient-to-r from-purple-50 to-blue-50 flex-shrink-0">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="relative">
                  <div className="w-10 h-10 rounded-full bg-gradient-to-br from-purple-500 to-blue-600 flex items-center justify-center shadow-lg">
                    <Bot className="w-6 h-6 text-white" />
                  </div>
                  {/* Pulse animation for active assistant */}
                  <div className="absolute inset-0 rounded-full bg-purple-500 opacity-75 animate-ping"></div>
                </div>
                <div>
                  <CardTitle className="text-base font-bold text-slate-900">AI Assistant</CardTitle>
                  <p className="text-xs text-slate-500 flex items-center gap-1">
                    <Circle className="w-2 h-2 fill-emerald-500 text-emerald-500" />
                    Active • Learning from your routes
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0 hidden lg:flex" // Hidden on mobile
                  onClick={() => setIsMinimized(!isMinimized)}>
                  {isMinimized ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0"
                  onClick={onClose}>
                  <X className="w-4 h-4" />
                </Button>
              </div>
            </div>
          </CardHeader>

          <AnimatePresence>
            {!isMinimized && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="flex-1 flex flex-col min-h-0">
                
                <CardContent className="p-0 flex-1 flex flex-col min-h-0">
                  {/* Messages */}
                  <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-gradient-to-b from-slate-50 to-white custom-scrollbar">
                    <AnimatePresence mode="popLayout">
                      {messages.map((message) => (
                        <AssistantMessage
                          key={message.id}
                          message={message}
                          onFeedback={handleFeedback}
                        />
                      ))}
                    </AnimatePresence>

                    {isLoading && (
                      <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        className="flex gap-3">
                        <div className="flex-shrink-0 w-8 h-8 rounded-full bg-gradient-to-br from-purple-500 to-blue-600 flex items-center justify-center shadow-lg">
                          <Bot className="w-5 h-5 text-white" />
                        </div>
                        <div className="bg-white border border-slate-200 rounded-2xl p-3 shadow-sm">
                          <div className="flex items-center gap-2">
                            <Loader2 className="w-4 h-4 animate-spin text-purple-600" />
                            <span className="text-sm text-slate-600">Analyzing route & traffic...</span>
                          </div>
                        </div>
                      </motion.div>
                    )}

                    <div ref={messagesEndRef} />
                  </div>

                  {/* Quick Actions */}
                  <div className="px-4 py-3 border-t border-b border-slate-200 bg-slate-50 flex-shrink-0">
                    <p className="text-xs font-medium text-slate-600 mb-2">Quick Actions:</p>
                    <div className="grid grid-cols-2 gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 text-xs justify-start gap-2"
                        onClick={() => handleQuickAction('optimize')}
                        disabled={isLoading}>
                        <Navigation className="w-3 h-3" />
                        Optimize Route
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 text-xs justify-start gap-2"
                        onClick={() => handleQuickAction('urgency')}
                        disabled={isLoading}>
                        <Clock className="w-3 h-3" />
                        Check Urgency
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 text-xs justify-start gap-2"
                        onClick={() => handleQuickAction('alerts')}
                        disabled={isLoading}>
                        <AlertTriangle className="w-3 h-3" />
                        Live Traffic
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 text-xs justify-start gap-2"
                        onClick={() => handleQuickAction('nearby')}
                        disabled={isLoading}>
                        <MapPin className="w-3 h-3" />
                        Find Clusters
                      </Button>
                      {/* Enhanced: Fridge items quick action with badge */}
                      <Button
                        variant="outline"
                        size="sm"
                        className={`h-8 text-xs justify-start gap-2 relative ${fridgeItemStats.critical > 0 ? 'border-cyan-400 bg-cyan-50' : ''}`}
                        onClick={() => handleQuickAction('fridge')}
                        disabled={isLoading}>
                        <Snowflake className={`w-3 h-3 ${fridgeItemStats.critical > 0 ? 'text-cyan-600' : ''}`} />
                        Fridge Items
                        {fridgeItemStats.total > 0 && (
                          <Badge className={`ml-auto text-xs px-1 h-4 ${
                            fridgeItemStats.critical > 0 
                              ? 'bg-red-500 text-white' 
                              : 'bg-cyan-100 text-cyan-700'
                          }`}>
                            {fridgeItemStats.critical > 0 ? `⚠️${fridgeItemStats.critical}` : fridgeItemStats.total}
                          </Badge>
                        )}
                      </Button>
                    </div>
                  </div>

                  {/* Input */}
                  <div className="p-4 bg-white flex-shrink-0">
                    <div className="flex gap-2">
                      <Input
                        value={inputMessage}
                        onChange={(e) => setInputMessage(e.target.value)}
                        onKeyPress={handleKeyPress}
                        placeholder="Ask me anything about your route..."
                        className="flex-1 text-sm"
                        disabled={isLoading}
                      />
                      <Button
                        onClick={handleSendMessage}
                        disabled={!inputMessage.trim() || isLoading}
                        className="bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-700 hover:to-blue-700 px-3 flex-shrink-0">
                        {isLoading ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Send className="w-4 h-4" />
                        )}
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </motion.div>
            )}
          </AnimatePresence>
        </Card>

        <style>{`
          .custom-scrollbar::-webkit-scrollbar {
            width: 6px;
          }
          .custom-scrollbar::-webkit-scrollbar-track {
            background: transparent;
          }
          .custom-scrollbar::-webkit-scrollbar-thumb {
            background: rgba(148, 163, 184, 0.3);
            border-radius: 10px;
          }
          .custom-scrollbar::-webkit-scrollbar-thumb:hover {
            background: rgba(148, 163, 184, 0.5);
          }
        `}</style>
      </motion.div>
    </>
  );
}