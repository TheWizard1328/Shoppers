import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { MapPin } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

/**
 * Displays total daily_generation_count for all drivers on selected date
 */
export default function PolylineCounter({ selectedDate }) {
  const [totalCount, setTotalCount] = useState(0);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!selectedDate) return;

    const fetchPolylineCount = async () => {
      try {
        setIsLoading(true);
        const polylines = await base44.entities.DriverRoutePolyline.filter({
          delivery_date: selectedDate
        });

        // Sum up all daily_generation_count values
        const total = polylines.reduce((sum, p) => sum + (p.daily_generation_count || 0), 0);
        setTotalCount(total);
      } catch (error) {
        console.error('Error fetching polyline count:', error);
        setTotalCount(0);
      } finally {
        setIsLoading(false);
      }
    };

    fetchPolylineCount();

    // Refresh every 30 seconds
    const interval = setInterval(fetchPolylineCount, 30000);
    return () => clearInterval(interval);
  }, [selectedDate]);

  if (isLoading && totalCount === 0) return null;

  return (
    <div className="flex items-center gap-2">
      <MapPin className="w-4 h-4 text-blue-600" />
      <span className="text-slate-600 font-medium text-sm">Polylines</span>
      <Badge variant="secondary" className="bg-slate-100 text-slate-700 justify-center w-[55px] rounded-[10px]">
        {totalCount}
      </Badge>
    </div>
  );
}