import React, { useState, useEffect } from 'react';
import { Badge } from '@/components/ui/badge';
import { Clock, TrendingUp, Zap } from 'lucide-react';
import { base44 } from '@/api/base44Client';

/**
 * Historical ETA Predictor
 * Shows predicted completion time based on historical delivery patterns
 */
export default function HistoricalETAPredictor({ 
  driverId, 
  deliveryDate, 
  remainingStops 
}) {
  const [prediction, setPrediction] = useState(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!driverId || !deliveryDate || !remainingStops || remainingStops === 0) {
      setPrediction(null);
      return;
    }

    const fetchPrediction = async () => {
      setIsLoading(true);
      try {
        // Fetch historical data for this driver
        const pastDate = new Date();
        pastDate.setMonth(pastDate.getMonth() - 3);
        const pastDateStr = pastDate.toISOString().split('T')[0];

        const historicalDeliveries = await base44.entities.Delivery.filter({
          driver_id: driverId,
          delivery_date: { $gte: pastDateStr },
          status: 'completed',
          actual_delivery_time: { $ne: null }
        }, '-delivery_date', 1000);

        if (historicalDeliveries.length < 10) {
          setPrediction(null);
          return;
        }

        // Calculate average time per stop from historical data
        const timePerStopSamples = [];
        
        // Group by date
        const deliveriesByDate = new Map();
        historicalDeliveries.forEach(d => {
          if (!deliveriesByDate.has(d.delivery_date)) {
            deliveriesByDate.set(d.delivery_date, []);
          }
          deliveriesByDate.get(d.delivery_date).push(d);
        });

        // For each day, calculate time from first to last delivery
        deliveriesByDate.forEach((dayDeliveries) => {
          if (dayDeliveries.length < 2) return;
          
          const sorted = dayDeliveries.sort((a, b) => 
            new Date(a.actual_delivery_time) - new Date(b.actual_delivery_time)
          );
          
          const firstTime = new Date(sorted[0].actual_delivery_time);
          const lastTime = new Date(sorted[sorted.length - 1].actual_delivery_time);
          const totalMinutes = (lastTime - firstTime) / (1000 * 60);
          const avgMinutesPerStop = totalMinutes / (sorted.length - 1);
          
          timePerStopSamples.push(avgMinutesPerStop);
        });

        if (timePerStopSamples.length === 0) {
          setPrediction(null);
          return;
        }

        // Calculate average time per stop
        const avgTimePerStop = timePerStopSamples.reduce((a, b) => a + b, 0) / timePerStopSamples.length;
        
        // Predict completion time
        const estimatedMinutesRemaining = Math.round(avgTimePerStop * remainingStops);
        const now = new Date();
        const completionTime = new Date(now.getTime() + estimatedMinutesRemaining * 60000);
        
        const hours = completionTime.getHours();
        const minutes = completionTime.getMinutes();
        const formattedTime = `${hours % 12 || 12}:${String(minutes).padStart(2, '0')} ${hours >= 12 ? 'PM' : 'AM'}`;

        setPrediction({
          completionTime: formattedTime,
          estimatedMinutes: estimatedMinutesRemaining,
          confidence: Math.min(95, Math.round((timePerStopSamples.length / 10) * 85)),
          basedOnDays: deliveriesByDate.size
        });

      } catch (error) {
        console.error('Failed to fetch historical prediction:', error);
        setPrediction(null);
      } finally {
        setIsLoading(false);
      }
    };

    fetchPrediction();
  }, [driverId, deliveryDate, remainingStops]);

  if (!prediction || isLoading) return null;

  return (
    <div className="bg-gradient-to-r from-purple-50 to-pink-50 border border-purple-200 rounded-lg p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Zap className="w-4 h-4 text-purple-600" />
          <span className="text-sm font-semibold text-purple-900">AI Prediction</span>
        </div>
        <Badge className="bg-purple-100 text-purple-800 text-xs">
          {prediction.confidence}% confident
        </Badge>
      </div>
      
      <div className="flex items-baseline gap-2">
        <Clock className="w-5 h-5 text-purple-600" />
        <div>
          <div className="text-2xl font-bold text-purple-900">{prediction.completionTime}</div>
          <div className="text-xs text-purple-700">
            Estimated completion (~{prediction.estimatedMinutes} min remaining)
          </div>
          <div className="text-xs text-purple-600 mt-1">
            Based on {prediction.basedOnDays} previous routes
          </div>
        </div>
      </div>
    </div>
  );
}