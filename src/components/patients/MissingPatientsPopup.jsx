import React, { useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { X, AlertTriangle, Search, ChevronDown, ChevronUp } from "lucide-react";

/**
 * Popup that shows patients in the database that are NOT in the imported CSV
 * Displayed after preview is generated but before confirming import
 */
export default function MissingPatientsPopup({ 
  missingPatients = [], 
  stores = [],
  importingStoreIds = [], // Store IDs being actively imported
  onClose,
  onContinue 
}) {
  const [searchTerm, setSearchTerm] = useState('');
  const [expandedStores, setExpandedStores] = useState(new Set());
  const [showAll, setShowAll] = useState(false);

  // Group missing patients by store
  const patientsByStore = useMemo(() => {
    const grouped = new Map();
    
    missingPatients.forEach(patient => {
      const storeId = patient.store_id || 'unassigned';
      if (!grouped.has(storeId)) {
        grouped.set(storeId, []);
      }
      grouped.get(storeId).push(patient);
    });
    
    // Sort by store name
    const sortedEntries = Array.from(grouped.entries()).sort((a, b) => {
      const storeA = stores.find(s => s.id === a[0]);
      const storeB = stores.find(s => s.id === b[0]);
      return (storeA?.name || 'ZZZ').localeCompare(storeB?.name || 'ZZZ');
    });
    
    return sortedEntries;
  }, [missingPatients, stores]);

  // Filter patients by search term
  const filteredPatientsByStore = useMemo(() => {
    if (!searchTerm.trim()) return patientsByStore;
    
    const term = searchTerm.toLowerCase();
    return patientsByStore
      .map(([storeId, patients]) => {
        const filtered = patients.filter(p => 
          (p.full_name || '').toLowerCase().includes(term) ||
          (p.address || '').toLowerCase().includes(term) ||
          (p.patient_id || '').toLowerCase().includes(term)
        );
        return [storeId, filtered];
      })
      .filter(([, patients]) => patients.length > 0);
  }, [patientsByStore, searchTerm]);

  const getStoreName = (storeId) => {
    if (storeId === 'unassigned') return 'Unassigned';
    const store = stores.find(s => s.id === storeId);
    return store?.name || 'Unknown Store';
  };

  const getStoreColor = (storeId) => {
    const store = stores.find(s => s.id === storeId);
    return store?.color || '#6b7280';
  };

  const toggleStore = (storeId) => {
    setExpandedStores(prev => {
      const newSet = new Set(prev);
      if (newSet.has(storeId)) {
        newSet.delete(storeId);
      } else {
        newSet.add(storeId);
      }
      return newSet;
    });
  };

  const expandAll = () => {
    setExpandedStores(new Set(patientsByStore.map(([storeId]) => storeId)));
  };

  const collapseAll = () => {
    setExpandedStores(new Set());
  };

  const totalFilteredCount = filteredPatientsByStore.reduce((sum, [, patients]) => sum + patients.length, 0);

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-[10000] overflow-hidden">
      <Card className="rounded-xl border bg-card text-card-foreground shadow w-full max-w-3xl max-h-[80vh] flex flex-col">
        <CardHeader className="flex flex-col space-y-1.5 p-4 border-b flex-shrink-0 bg-yellow-50">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <AlertTriangle className="w-6 h-6 text-yellow-600" />
              <div>
                <CardTitle className="text-yellow-800">
                  Missing Patients Found
                </CardTitle>
                <p className="text-sm text-yellow-700 mt-1">
                  {missingPatients.length} patient{missingPatients.length !== 1 ? 's' : ''} in database but NOT in imported CSV
                </p>
              </div>
            </div>
            <Button variant="ghost" size="icon" onClick={onClose}>
              <X className="w-4 h-4" />
            </Button>
          </div>
        </CardHeader>

        <div className="p-3 border-b bg-slate-50 flex-shrink-0">
          <div className="flex items-center gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <Input
                placeholder="Search by name, address, or PID..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-9"
              />
            </div>
            <Button variant="outline" size="sm" onClick={expandAll}>
              Expand All
            </Button>
            <Button variant="outline" size="sm" onClick={collapseAll}>
              Collapse All
            </Button>
          </div>
          {searchTerm && (
            <p className="text-xs text-slate-500 mt-2">
              Showing {totalFilteredCount} of {missingPatients.length} patients
            </p>
          )}
        </div>

        <CardContent className="flex-1 overflow-y-auto p-4 space-y-3">
          {filteredPatientsByStore.length === 0 ? (
            <div className="text-center text-slate-500 py-8">
              No patients found matching "{searchTerm}"
            </div>
          ) : (
            filteredPatientsByStore.map(([storeId, patients]) => {
              const isExpanded = expandedStores.has(storeId);
              const displayPatients = showAll || isExpanded ? patients : patients.slice(0, 5);
              
              return (
                <div key={storeId} className="border rounded-lg overflow-hidden">
                  <button
                    onClick={() => toggleStore(storeId)}
                    className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      <Badge 
                        style={{ backgroundColor: getStoreColor(storeId) }}
                        className="text-white"
                      >
                        {getStoreName(storeId)}
                      </Badge>
                      <span className="text-sm text-slate-600">
                        {patients.length} patient{patients.length !== 1 ? 's' : ''}
                      </span>
                    </div>
                    {isExpanded ? (
                      <ChevronUp className="w-4 h-4 text-slate-500" />
                    ) : (
                      <ChevronDown className="w-4 h-4 text-slate-500" />
                    )}
                  </button>
                  
                  {isExpanded && (
                    <div className="divide-y">
                      {displayPatients.map((patient, idx) => (
                        <div 
                          key={patient.id || idx} 
                          className="px-3 py-2 text-sm flex items-center gap-3 hover:bg-slate-50"
                        >
                          <span className="font-mono text-xs bg-slate-200 px-2 py-0.5 rounded w-20 text-center truncate">
                            {patient.patient_id || 'NO PID'}
                          </span>
                          <span className="font-medium flex-shrink-0 w-40 truncate" title={patient.full_name}>
                            {patient.full_name}
                          </span>
                          <span className="text-slate-600 flex-1 truncate" title={patient.address}>
                            {patient.address}
                          </span>
                          {patient.status === 'inactive' && (
                            <Badge variant="outline" className="text-xs text-red-600 border-red-300">
                              Inactive
                            </Badge>
                          )}
                        </div>
                      ))}
                      {!showAll && !isExpanded && patients.length > 5 && (
                        <div className="px-3 py-2 text-center text-sm text-slate-500">
                          ... and {patients.length - 5} more
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </CardContent>

        <div className="border-t p-4 flex justify-between items-center flex-shrink-0 bg-slate-50">
          <p className="text-sm text-slate-600">
            These patients exist in your database but were not found in the CSV file.
          </p>
          <div className="flex gap-3">
            <Button variant="outline" onClick={onClose}>
              Back to Preview
            </Button>
            <Button 
              onClick={onContinue}
              className="bg-emerald-600 hover:bg-emerald-700"
            >
              Continue to Import
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}