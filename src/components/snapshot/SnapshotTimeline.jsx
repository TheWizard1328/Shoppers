import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { format } from 'date-fns';
import { Clock, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';

export default function SnapshotTimeline({ 
  selectedDate, 
  selectedDriverId, 
  onSnapshotSelect,
  onClose 
}) {
  const [snapshots, setSnapshots] = useState([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const fetchSnapshots = async () => {
      if (!selectedDate) return;
      
      setIsLoading(true);
      try {
        const dateStr = typeof selectedDate === 'string' 
          ? selectedDate 
          : format(selectedDate, 'yyyy-MM-dd');
        
        // Fetch snapshots for the selected date
        const snapshotRecords = await base44.entities.DashboardSnapshot.filter({
          snapshot_date: dateStr
        });
        
        // Sort by timestamp (oldest to newest)
        const sorted = snapshotRecords.sort((a, b) => 
          new Date(a.timestamp) - new Date(b.timestamp)
        );
        
        setSnapshots(sorted);
        
        // Auto-select most recent snapshot
        if (sorted.length > 0) {
          setSelectedIndex(sorted.length - 1);
          onSnapshotSelect(sorted[sorted.length - 1]);
        }
      } catch (error) {
        console.error('Error fetching snapshots:', error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchSnapshots();
  }, [selectedDate]);

  const handleSliderChange = (value) => {
    const index = value[0];
    setSelectedIndex(index);
    
    if (snapshots[index]) {
      onSnapshotSelect(snapshots[index]);
    }
  };

  if (isLoading) {
    return (
      <div className="h-full w-20 flex items-center justify-center bg-slate-900/90 backdrop-blur-sm">
        <div className="animate-spin w-6 h-6 border-2 border-white border-t-transparent rounded-full" />
      </div>
    );
  }

  if (snapshots.length === 0) {
    return (
      <div className="h-full w-20 bg-slate-900/90 backdrop-blur-sm text-white p-2 flex flex-col items-center">
        <div className="flex flex-col items-center">
          <Button 
            variant="ghost" 
            size="sm" 
            onClick={onClose}
            className="text-white hover:bg-white/20 h-8 w-8 p-0 mb-2"
          >
            <X className="w-4 h-4" />
          </Button>
          <p className="text-xs text-slate-300 text-center">
            No snapshots
          </p>
        </div>
      </div>
    );
  }

  const currentSnapshot = snapshots[selectedIndex];

  return (
    <div className="h-full w-20 bg-slate-900/90 backdrop-blur-sm text-white p-2 flex flex-col">
      <div className="flex flex-col items-center mb-2">
        <Button 
          variant="ghost" 
          size="sm" 
          onClick={onClose}
          className="text-white hover:bg-white/20 h-8 w-8 p-0 mb-2"
        >
          <X className="w-4 h-4" />
        </Button>
        <Clock className="w-5 h-5 mb-1" />
      </div>

      <div className="flex-1 flex flex-col justify-center items-center">
        {/* Vertical slider */}
        <Slider
          value={[selectedIndex]}
          min={0}
          max={snapshots.length - 1}
          step={1}
          orientation="vertical"
          onValueChange={handleSliderChange}
          className="h-[50vh] mb-4"
        />

        {/* Time display */}
        <div className="text-center space-y-1">
          <div className="text-sm font-bold">
            {format(new Date(currentSnapshot.timestamp), 'h:mm')}
          </div>
          <div className="text-xs text-slate-400">
            {selectedIndex + 1}/{snapshots.length}
          </div>
        </div>
      </div>
    </div>
  );
}