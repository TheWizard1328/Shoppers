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
      <div className="h-full w-16 flex items-center justify-center bg-slate-900/90 backdrop-blur-sm">
        <div className="animate-spin w-6 h-6 border-2 border-white border-t-transparent rounded-full" />
      </div>
    );
  }

  if (snapshots.length === 0) {
    return (
      <div className="h-full w-64 bg-slate-900/90 backdrop-blur-sm text-white p-4 flex flex-col">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-bold">No Snapshots</h3>
          <Button 
            variant="ghost" 
            size="sm" 
            onClick={onClose}
            className="text-white hover:bg-white/20 h-8 w-8 p-0"
          >
            <X className="w-4 h-4" />
          </Button>
        </div>
        <p className="text-sm text-slate-300">
          No snapshots available for {format(selectedDate, 'MMM dd, yyyy')}
        </p>
      </div>
    );
  }

  const currentSnapshot = snapshots[selectedIndex];

  return (
    <div className="h-full w-64 bg-slate-900/90 backdrop-blur-sm text-white p-4 flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-bold flex items-center gap-2">
          <Clock className="w-4 h-4" />
          Timeline
        </h3>
        <Button 
          variant="ghost" 
          size="sm" 
          onClick={onClose}
          className="text-white hover:bg-white/20 h-8 w-8 p-0"
        >
          <X className="w-4 h-4" />
        </Button>
      </div>

      <div className="flex-1 flex flex-col justify-center py-4">
        {/* Vertical slider */}
        <div className="flex justify-center mb-6">
          <Slider
            value={[selectedIndex]}
            min={0}
            max={snapshots.length - 1}
            step={1}
            orientation="vertical"
            onValueChange={handleSliderChange}
            className="h-[60vh]"
          />
        </div>

        {/* Time display */}
        <div className="text-center space-y-2">
          <div className="text-2xl font-bold">
            {format(new Date(currentSnapshot.timestamp), 'h:mm a')}
          </div>
          <div className="text-sm text-slate-300">
            {format(new Date(currentSnapshot.timestamp), 'MMM dd, yyyy')}
          </div>
          <div className="text-xs text-slate-400">
            Snapshot {selectedIndex + 1} of {snapshots.length}
          </div>
        </div>
      </div>
    </div>
  );
}