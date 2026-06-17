import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { CheckCircle2, XCircle, Clock, User, Store, CalendarDays, Loader2, RefreshCw, Play } from 'lucide-react';
import { format } from 'date-fns';

const PATTERN_LABELS = {
  recurring_daily: 'Daily',
  recurring_weekly_mon: 'Weekly (Mon)',
  recurring_weekly_tue: 'Weekly (Tue)',
  recurring_weekly_wed: 'Weekly (Wed)',
  recurring_weekly_thu: 'Weekly (Thu)',
  recurring_weekly_fri: 'Weekly (Fri)',
  recurring_weekly_sat: 'Weekly (Sat)',
  recurring_weekly_sun: 'Weekly (Sun)',
  recurring_biweekly: 'Bi-Weekly',
  recurring_weekly_x4: 'Weekly x4',
  recurring_monthly: 'Monthly',
  recurring_bimonthly: 'Bi-Monthly',
};

export default function PatientAnalysisReview({ stores = [] }) {
  const [results, setResults] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRunning, setIsRunning] = useState(false);
  const [runStatus, setRunStatus] = useState('');
  const [filterStore, setFilterStore] = useState('all');
  const [filterStatus, setFilterStatus] = useState('pending_review');
  const [selectedResult, setSelectedResult] = useState(null);
  const [applyingId, setApplyingId] = useState(null);

  const loadResults = async () => {
    setIsLoading(true);
    const filter = {};
    if (filterStore !== 'all') filter.store_id = filterStore;
    if (filterStatus !== 'all') filter.status = filterStatus;
    
    const data = await base44.entities.PatientAnalysisResult.filter(filter, '-analysis_date', 200);
    setResults(data || []);
    setIsLoading(false);
  };

  useEffect(() => { loadResults(); }, [filterStore, filterStatus]);

  const handleRunScan = async (storeId = null) => {
    setIsRunning(true);
    setRunStatus('Running scan...');
    const payload = storeId ? { store_id: storeId } : {};
    try {
      const res = await base44.functions.invoke('scanPatientHistoryForStore', payload);
      const summary = res?.data?.summary;
      if (summary) {
        setRunStatus(`Done! Scanned ${summary.patients_scanned} patients. Inactive: ${summary.marked_inactive}, Patterns: ${summary.patterns_detected}, Needs review: ${summary.ambiguous_patterns}`);
      } else {
        setRunStatus(res?.data?.message || 'Scan complete.');
      }
    } catch (err) {
      console.error('Scan failed:', err);
      const apiMsg = err?.response?.data?.error || err?.response?.data?.message;
      setRunStatus(apiMsg || err?.message || 'Scan failed with an unknown error.');
    } finally {
      setIsRunning(false);
      loadResults();
    }
  };

  const handleApplyPattern = async (result, patternKey) => {
    setApplyingId(result.id);
    
    const updateData = { recurring: true };
    const selectedPattern = result.suggested_patterns?.find(p => p.pattern_key === patternKey);
    
    if (patternKey === 'recurring_weekly_x4' && selectedPattern?.x4_day) {
      updateData.recurring_weekly_x4 = true;
      updateData.recurring_weekly_x4_day = selectedPattern.x4_day;
    } else {
      updateData[patternKey] = true;
    }

    await base44.entities.Patient.update(result.patient_id, updateData);
    await base44.entities.PatientAnalysisResult.update(result.id, {
      status: 'applied',
      applied_pattern: patternKey,
      reviewed_at: new Date().toISOString()
    });

    setResults(prev => prev.map(r => r.id === result.id 
      ? { ...r, status: 'applied', applied_pattern: patternKey } 
      : r
    ));
    setSelectedResult(null);
    setApplyingId(null);
  };

  const handleDismiss = async (result) => {
    setApplyingId(result.id);
    await base44.entities.PatientAnalysisResult.update(result.id, {
      status: 'dismissed',
      reviewed_at: new Date().toISOString()
    });
    setResults(prev => prev.map(r => r.id === result.id ? { ...r, status: 'dismissed' } : r));
    setSelectedResult(null);
    setApplyingId(null);
  };

  const getStatusBadge = (status) => {
    if (status === 'pending_review') return <Badge className="bg-amber-100 text-amber-800 border-amber-200">Pending Review</Badge>;
    if (status === 'applied') return <Badge className="bg-green-100 text-green-800 border-green-200">Applied</Badge>;
    if (status === 'dismissed') return <Badge className="bg-slate-100 text-slate-600 border-slate-200">Dismissed</Badge>;
    return null;
  };

  const getResultTypeBadge = (type) => {
    if (type === 'inactivity_flagged') return <Badge className="bg-red-100 text-red-800 border-red-200">Inactivity</Badge>;
    if (type === 'pattern_ambiguous') return <Badge className="bg-orange-100 text-orange-800 border-orange-200">Ambiguous Pattern</Badge>;
    if (type === 'pattern_detected') return <Badge className="bg-blue-100 text-blue-800 border-blue-200">Pattern Detected</Badge>;
    return null;
  };

  const pendingCount = results.filter(r => r.status === 'pending_review').length;

  return (
    <div className="space-y-4">
      {/* Header / Run Controls */}
      <Card style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center justify-between flex-wrap gap-2" style={{ color: 'var(--text-slate-900)' }}>
            <div className="flex items-center gap-2">
              Patient History Analysis
              {pendingCount > 0 && (
                <Badge className="bg-amber-500 text-white">{pendingCount} pending</Badge>
              )}
            </div>
            <div className="flex gap-2 flex-wrap">
              <Select value={filterStore} onValueChange={setFilterStore}>
                <SelectTrigger className="w-40 h-8 text-xs">
                  <SelectValue placeholder="All stores" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Stores</SelectItem>
                  {stores.filter(s => s.status === 'active').map(s => (
                    <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Button
                variant="outline"
                size="sm"
                onClick={() => handleRunScan(filterStore !== 'all' ? filterStore : null)}
                disabled={isRunning}
                className="gap-1 text-xs"
              >
                {isRunning ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                {isRunning ? 'Running...' : filterStore !== 'all' ? 'Run for Store' : 'Run All Due'}
              </Button>

              <Button variant="outline" size="sm" onClick={loadResults} disabled={isLoading} className="gap-1 text-xs">
                <RefreshCw className={`w-3 h-3 ${isLoading ? 'animate-spin' : ''}`} />
                Refresh
              </Button>
            </div>
          </CardTitle>
          {runStatus && (
            <CardDescription className="text-xs mt-1 text-emerald-700 bg-emerald-50 rounded p-2">
              {runStatus}
            </CardDescription>
          )}
        </CardHeader>
        <CardContent className="pt-0">
          {/* Status filter tabs */}
          <div className="flex gap-2 flex-wrap">
            {['pending_review', 'applied', 'dismissed', 'all'].map(s => (
              <Button
                key={s}
                variant={filterStatus === s ? 'default' : 'outline'}
                size="sm"
                onClick={() => setFilterStatus(s)}
                className="text-xs h-7"
              >
                {s === 'pending_review' ? 'Pending Review' : s === 'all' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1)}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Results List */}
      {isLoading ? (
        <div className="flex items-center justify-center h-40">
          <Loader2 className="w-6 h-6 animate-spin text-emerald-500" />
          <span className="ml-2 text-sm" style={{ color: 'var(--text-slate-600)' }}>Loading results...</span>
        </div>
      ) : results.length === 0 ? (
        <div className="text-center py-12 text-sm" style={{ color: 'var(--text-slate-500)' }}>
          No analysis results found.
        </div>
      ) : (
        <div className="space-y-2">
          {results.map(result => (
            <Card key={result.id} className="cursor-pointer hover:shadow-md transition-shadow" 
              style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}
              onClick={() => result.status === 'pending_review' ? setSelectedResult(result) : null}
            >
              <CardContent className="p-3">
                <div className="flex items-start justify-between gap-2 flex-wrap">
                  <div className="flex items-start gap-3 min-w-0">
                    <User className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: 'var(--text-slate-400)' }} />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-sm" style={{ color: 'var(--text-slate-900)' }}>
                          {result.patient_name}
                        </span>
                        {getResultTypeBadge(result.result_type)}
                        {getStatusBadge(result.status)}
                      </div>
                      <div className="flex items-center gap-3 mt-1 text-xs flex-wrap" style={{ color: 'var(--text-slate-500)' }}>
                        <span className="flex items-center gap-1">
                          <Store className="w-3 h-3" />{result.store_name}
                        </span>
                        {result.last_delivery_date && (
                          <span className="flex items-center gap-1">
                            <CalendarDays className="w-3 h-3" />
                            Last: {result.last_delivery_date}
                          </span>
                        )}
                        <span>{result.total_deliveries_analyzed} deliveries analyzed</span>
                        <span>Scanned: {result.analysis_date}</span>
                      </div>

                      {/* Pattern suggestions preview */}
                      {result.suggested_patterns && result.suggested_patterns.length > 0 && (
                        <div className="flex gap-1 mt-1.5 flex-wrap">
                          {result.suggested_patterns.slice(0, 3).map((p, i) => (
                            <span key={i} className="text-xs px-2 py-0.5 rounded-full border"
                              style={{ 
                                background: result.applied_pattern === p.pattern_key ? 'var(--bg-emerald-50)' : 'var(--bg-slate-50)',
                                borderColor: result.applied_pattern === p.pattern_key ? '#10b981' : 'var(--border-slate-200)',
                                color: result.applied_pattern === p.pattern_key ? '#065f46' : 'var(--text-slate-700)'
                              }}>
                              {p.pattern_label} ({p.confidence}%)
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  {result.status === 'pending_review' && (
                    <Button size="sm" className="bg-amber-500 hover:bg-amber-600 text-white text-xs flex-shrink-0">
                      Review
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Review Dialog */}
      {selectedResult && (
        <Dialog open={true} onOpenChange={() => setSelectedResult(null)}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Review Pattern for {selectedResult.patient_name}</DialogTitle>
              <DialogDescription>
                {selectedResult.total_deliveries_analyzed} deliveries analyzed from {selectedResult.store_name}.
                Last delivery: {selectedResult.last_delivery_date || 'N/A'}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-3 py-2">
              <p className="text-sm font-medium" style={{ color: 'var(--text-slate-700)' }}>
                Select the correct recurring pattern:
              </p>
              {(selectedResult.suggested_patterns || []).map((p, i) => (
                <div key={i} className="flex items-start justify-between gap-3 p-3 rounded-lg border"
                  style={{ borderColor: 'var(--border-slate-200)', background: i === 0 ? 'var(--bg-emerald-50)' : 'var(--bg-slate-50)' }}>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm" style={{ color: 'var(--text-slate-900)' }}>
                        {p.pattern_label}
                      </span>
                      <Badge className={`text-xs ${i === 0 ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600'}`}>
                        {p.confidence}% confidence
                      </Badge>
                      {i === 0 && <Badge className="text-xs bg-blue-100 text-blue-800">Top match</Badge>}
                    </div>
                    <p className="text-xs mt-1" style={{ color: 'var(--text-slate-500)' }}>{p.supporting_data}</p>
                  </div>
                  <Button
                    size="sm"
                    onClick={() => handleApplyPattern(selectedResult, p.pattern_key)}
                    disabled={applyingId === selectedResult.id}
                    className="flex-shrink-0 bg-emerald-600 hover:bg-emerald-700 text-xs"
                  >
                    {applyingId === selectedResult.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3 mr-1" />}
                    Apply
                  </Button>
                </div>
              ))}
            </div>

            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => setSelectedResult(null)}>Cancel</Button>
              <Button
                variant="outline"
                className="text-red-600 border-red-200 hover:bg-red-50"
                onClick={() => handleDismiss(selectedResult)}
                disabled={applyingId === selectedResult.id}
              >
                <XCircle className="w-4 h-4 mr-1" />
                Dismiss
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}