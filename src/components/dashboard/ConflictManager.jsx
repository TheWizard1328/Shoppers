/**
 * Global Conflict Manager
 * Listens for conflicts and shows resolution UI
 */

import React, { useState, useEffect } from 'react';
import { getPendingConflicts, resolveConflictManually, subscribeToConflicts } from '../utils/offlineConflictResolver';
import ConflictResolutionDialog from '../offline/ConflictResolutionDialog';

export default function ConflictManager() {
  const [conflicts, setConflicts] = useState([]);
  const [showDialog, setShowDialog] = useState(false);
  
  useEffect(() => {
    // Check for existing conflicts on mount
    const existing = getPendingConflicts();
    if (existing.length > 0) {
      setConflicts(existing);
      setShowDialog(true);
    }
    
    // Subscribe to new conflicts
    const unsubscribe = subscribeToConflicts((conflict) => {
      setConflicts(prev => [...prev, conflict]);
      setShowDialog(true);
    });
    
    // Listen for global conflict events
    const handleConflictEvent = (event) => {
      const { conflicts: newConflicts } = event.detail || {};
      if (newConflicts && newConflicts.length > 0) {
        setConflicts(prev => [...prev, ...newConflicts]);
        setShowDialog(true);
      }
    };
    
    window.addEventListener('dataConflictsDetected', handleConflictEvent);
    
    return () => {
      unsubscribe();
      window.removeEventListener('dataConflictsDetected', handleConflictEvent);
    };
  }, []);
  
  const handleResolve = async (conflictId, resolution) => {
    const result = await resolveConflictManually(conflictId, resolution);
    
    if (result.success) {
      // Remove resolved conflict from state
      setConflicts(prev => prev.filter(c => c.id !== conflictId));
      
      // Refresh data after resolution
      window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));
      
      // If no more conflicts, close dialog
      if (conflicts.length <= 1) {
        setShowDialog(false);
      }
    } else {
      alert('Failed to resolve conflict: ' + result.error);
    }
  };
  
  if (!showDialog || conflicts.length === 0) return null;
  
  return (
    <ConflictResolutionDialog
      conflicts={conflicts}
      onResolve={handleResolve}
      onClose={() => setShowDialog(false)}
    />
  );
}