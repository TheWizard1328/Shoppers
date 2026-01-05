import React, { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { AlertTriangle, Clock, Database, Smartphone } from 'lucide-react';
import { format } from 'date-fns';

export default function ConflictResolutionDialog({ conflicts, onResolve, onClose }) {
  const [currentIndex, setCurrentIndex] = useState(0);
  
  if (!conflicts || conflicts.length === 0) return null;
  
  const conflict = conflicts[currentIndex];
  const hasMore = currentIndex < conflicts.length - 1;
  
  const handleResolve = (resolution) => {
    onResolve(conflict.id || conflict.action?.id, resolution);
    
    if (hasMore) {
      setCurrentIndex(prev => prev + 1);
    } else {
      onClose();
    }
  };
  
  const formatValue = (value) => {
    if (value === null || value === undefined) return 'N/A';
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    if (typeof value === 'object') return JSON.stringify(value, null, 2);
    return String(value);
  };
  
  const getChangedFields = () => {
    const clientData = conflict.localRecord || conflict.action?.data || {};
    const serverData = conflict.serverRecord || conflict.serverData || {};
    
    const allKeys = new Set([...Object.keys(clientData), ...Object.keys(serverData)]);
    const changes = [];
    
    allKeys.forEach(key => {
      if (key.startsWith('_') || key === 'id' || key === 'created_date' || key === 'updated_date') return; // Skip internal fields
      
      const clientValue = clientData[key];
      const serverValue = serverData[key];
      
      if (JSON.stringify(clientValue) !== JSON.stringify(serverValue)) {
        changes.push({
          field: key,
          clientValue,
          serverValue
        });
      }
    });
    
    return changes;
  };
  
  const changedFields = getChangedFields();
  
  return (
    <Dialog open={true} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto z-[10002]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-orange-500" />
            Data Conflict Detected
            {conflicts.length > 1 && (
              <span className="text-sm font-normal text-slate-500">
                ({currentIndex + 1} of {conflicts.length})
              </span>
            )}
          </DialogTitle>
        </DialogHeader>
        
        <div className="space-y-4">
          <p className="text-sm text-slate-600">
            This record was modified both offline and online. Choose which version to keep:
          </p>
          
          <div className="grid grid-cols-2 gap-4">
            {/* Your Changes (Client) */}
            <div className="border border-blue-200 rounded-lg p-4 bg-blue-50/50">
              <div className="flex items-center gap-2 mb-3">
                <Smartphone className="w-4 h-4 text-blue-600" />
                <h3 className="font-semibold text-blue-900">Your Changes</h3>
              </div>
              <div className="space-y-2 text-sm">
                <div className="flex items-center gap-2 text-slate-600">
                  <Clock className="w-3 h-3" />
                  <span>{conflict.timestamp ? format(new Date(conflict.timestamp), 'MMM dd, HH:mm:ss') : format(new Date(conflict.action?.timestamp), 'MMM dd, HH:mm:ss')}</span>
                </div>
              </div>
            </div>
            
            {/* Server Version */}
            <div className="border border-emerald-200 rounded-lg p-4 bg-emerald-50/50">
              <div className="flex items-center gap-2 mb-3">
                <Database className="w-4 h-4 text-emerald-600" />
                <h3 className="font-semibold text-emerald-900">Server Version</h3>
              </div>
              <div className="space-y-2 text-sm">
                <div className="flex items-center gap-2 text-slate-600">
                  <Clock className="w-3 h-3" />
                  <span>
                    {conflict.serverData?.updated_date 
                      ? format(new Date(conflict.serverData.updated_date), 'MMM dd, HH:mm:ss')
                      : 'Unknown'}
                  </span>
                </div>
              </div>
            </div>
          </div>
          
          {/* Changed Fields Comparison */}
          {changedFields.length > 0 && (
            <div className="border border-slate-200 rounded-lg p-4 bg-white">
              <h4 className="font-semibold text-slate-900 mb-3">Changed Fields:</h4>
              <div className="space-y-3">
                {changedFields.map((change, idx) => (
                  <div key={idx} className="border-b border-slate-100 last:border-0 pb-2 last:pb-0">
                    <div className="font-medium text-sm text-slate-700 mb-1">
                      {change.field.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div className="bg-blue-50 rounded px-2 py-1">
                        <div className="text-blue-600 font-medium mb-0.5">Your Value:</div>
                        <div className="text-slate-700 break-words">{formatValue(change.clientValue)}</div>
                      </div>
                      <div className="bg-emerald-50 rounded px-2 py-1">
                        <div className="text-emerald-600 font-medium mb-0.5">Server Value:</div>
                        <div className="text-slate-700 break-words">{formatValue(change.serverValue)}</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        
        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={() => handleResolve('server')}
            className="gap-2"
          >
            <Database className="w-4 h-4" />
            Keep Server
          </Button>
          <Button
            onClick={() => handleResolve('merge')}
            className="gap-2 bg-purple-600 hover:bg-purple-700"
          >
            Merge Fields
          </Button>
          <Button
            onClick={() => handleResolve('local')}
            className="gap-2 bg-blue-600 hover:bg-blue-700"
          >
            <Smartphone className="w-4 h-4" />
            Keep Mine
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}