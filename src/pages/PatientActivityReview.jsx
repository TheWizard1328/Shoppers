import React, { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { runPatientActivityScan } from '@/functions/runPatientActivityScan';
import { format } from 'date-fns';
import { RefreshCw, CheckCircle, XCircle, AlertTriangle, Activity, ChevronDown, ChevronUp } from 'lucide-react';

const RESULT_TYPE_LABELS = {
  inactivity_flagged: 'Inactivity',
  pattern_ambiguous: 'Ambiguous Pattern',
  pattern_detected: 'Pattern Detected'
};

const STATUS_COLORS = {
  pending_review: 'bg-yellow-100 text-yellow-800 border-yellow-200',
  applied: 'bg-green-100 text-green-800 border-green-200',
  dismissed: 'bg-slate-100 text-slate-500 border-slate-200'
};

const RESULT_TYPE_COLORS = {
  inactivity_flagged: 'bg-red-100 text-red-700 border-red-200',
  pattern_ambiguous: 'bg-orange-100 text-orange-700 border-orange-200',
  pattern_detected: 'bg-blue-100 text-blue-700 border-blue-200'
};

function PatientResultCard({ result, stores, onApply, onDismiss }) {
  const [expanded, setExpanded] = useState(false);
  const [applyingPattern, setApplyingPattern] = useState(null);
  const [loading, setLoading] = useState(false);

  const store = stores.find(s => s.id === result.store_id);
  const isPending = result.status === 'pending_review';

  const handleApply = async (pattern) => {
    setLoading(true);
    setApplyingPattern(pattern.pattern_key);
    await onApply(result, pattern);
    setLoading(false);
    setApplyingPattern(null);
  };

  const handleDismiss = async () => {
    setLoading(true);
    await onDismiss(result);
    setLoading(false);
  };

  return (
    <Card className={`border ${isPending ? 'border-yellow-200 bg-yellow-50/30' : 'border-slate-200 bg-white'} transition-all`}>
      <CardHeader className="pb-2 pt-3 px-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-slate-800 truncate">{result.patient_name}</span>
              <Badge className={`text-xs border ${RESULT_TYPE_COLORS[result.result_type]}`}>
                {RESULT_TYPE_LABELS[result.result_type]}
              </Badge>
              <Badge className={`text-xs border ${STATUS_COLORS[result.status]}`}>
                {result.status === 'pending_review' ? 'Pending Review' : result.status === 'applied' ? 'Applied' : 'Dismissed'}
              </Badge>
            </div>
            <div className="text-xs text-slate-500 mt-1 flex gap-3 flex-wrap">
              <span>{store?.name || result.store_name}</span>
              <span>Analyzed: {result.analysis_date}</span>
              {result.last_delivery_date && <span>Last delivery: {result.last_delivery_date}</span>}
              <span>{result.total_deliveries_analyzed} deliveries analyzed</span>
            </div>
          </div>
          <button onClick={() => setExpanded(v => !v)} className="text-slate-400 hover:text-slate-600 p-1">
            {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
        </div>
      </CardHeader>

      {expanded && (
        <CardContent className="pt-0 px-4 pb-4">
          {result.result_type === 'inactivity_flagged' && (
            <div className="text-sm text-red-700 bg-red-50 rounded-md p-3 mt-2">
              Patient marked <strong>inactive</strong> — no completed deliveries in the past 6 months.
            </div>
          )}

          {(result.result_type === 'pattern_detected' || result.result_type === 'pattern_ambiguous') && (
            <div className="mt-2 space-y-2">
              {result.result_type === 'pattern_ambiguous' && (
                <p className="text-xs text-orange-700 bg-orange-50 rounded p-2">
                  Multiple patterns detected. Please choose the best match based on your knowledge of this patient.
                </p>
              )}
              {result.applied_pattern && (
                <p className="text-xs text-green-700 bg-green-50 rounded p-2">
                  Applied pattern: <strong>{result.applied_pattern}</strong>
                </p>
              )}
              <div className="space-y-2">
                {(result.suggested_patterns || []).map((pattern, idx) => (
                  <div key={idx} className="flex items-start gap-3 p-3 bg-slate-50 rounded-lg border border-slate-200">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-sm text-slate-800">{pattern.pattern_label}</span>
                        <span className="text-xs text-slate-500">Confidence: {pattern.confidence}%</span>
                        {idx === 0 && <Badge className="text-xs bg-blue-100 text-blue-700 border-blue-200">Best Match</Badge>}
                      </div>
                      <p className="text-xs text-slate-500 mt-0.5">{pattern.supporting_data}</p>
                    </div>
                    {isPending && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={loading}
                        onClick={() => handleApply(pattern)}
                        className="shrink-0 text-xs h-7 border-blue-300 text-blue-700 hover:bg-blue-50"
                      >
                        {loading && applyingPattern === pattern.pattern_key ? 'Applying...' : 'Apply'}
                      </Button>
                    )}
                  </div>
                ))}
              </div>

              {isPending && (
                <div className="flex justify-end pt-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={loading}
                    onClick={handleDismiss}
                    className="text-xs text-slate-500 hover:text-red-600"
                  >
                    <XCircle className="w-3.5 h-3.5 mr-1" />
                    Dismiss
                  </Button>
                </div>
              )}
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}

export default function PatientActivityReview() {
  const [results, setResults] = useState([]);
  const [stores, setStores] = useState([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [filterStatus, setFilterStatus] = useState('pending_review');
  const [filterStore, setFilterStore] = useState('all');
  const [filterType, setFilterType] = useState('all');
  const [scanMessage, setScanMessage] = useState('');

  const loadData = useCallback(async () => {
    setLoading(true);
    const [allResults, allStores] = await Promise.all([
      base44.entities.PatientAnalysisResult.list('-analysis_date', 500),
      base44.entities.Store.filter({ status: 'active' })
    ]);
    setResults(allResults);
    setStores(allStores);
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const handleRunScan = async (storeId) => {
    setScanning(true);
    setScanMessage('');
    const payload = storeId && storeId !== 'all' ? { store_id: storeId } : {};
    const res = await runPatientActivityScan(payload);
    const data = res.data;
    setScanMessage(
      data.success
        ? `Scan complete — ${data.patients_flagged_inactive || 0} inactive, ${data.patterns_detected || 0} patterns detected, ${data.patterns_ambiguous || 0} ambiguous.`
        : `Error: ${data.error || 'Unknown error'}`
    );
    setScanning(false);
    loadData();
  };

  const handleApply = async (result, pattern) => {
    // Build update payload for the patient
    const patientUpdate = {
      recurring: true,
      recurring_daily: false,
      recurring_weekly_mon: false, recurring_weekly_tue: false, recurring_weekly_wed: false,
      recurring_weekly_thu: false, recurring_weekly_fri: false, recurring_weekly_sat: false,
      recurring_weekly_sun: false,
      recurring_biweekly: false, recurring_weekly_x4: false,
      recurring_monthly: false, recurring_bimonthly: false
    };

    if (pattern.pattern_key === 'recurring_daily') {
      patientUpdate.recurring_daily = true;
    } else if (pattern.pattern_key.startsWith('recurring_weekly_') && pattern.pattern_key !== 'recurring_weekly_x4') {
      patientUpdate[pattern.pattern_key] = true;
    } else if (pattern.pattern_key === 'recurring_biweekly') {
      patientUpdate.recurring_biweekly = true;
    } else if (pattern.pattern_key === 'recurring_weekly_x4') {
      patientUpdate.recurring_weekly_x4 = true;
      if (pattern.x4_day) patientUpdate.recurring_weekly_x4_day = pattern.x4_day;
    } else if (pattern.pattern_key === 'recurring_monthly') {
      patientUpdate.recurring_monthly = true;
    } else if (pattern.pattern_key === 'recurring_bimonthly') {
      patientUpdate.recurring_bimonthly = true;
    }

    await base44.entities.Patient.update(result.patient_id, patientUpdate);
    await base44.entities.PatientAnalysisResult.update(result.id, {
      status: 'applied',
      applied_pattern: pattern.pattern_key,
      reviewed_at: new Date().toISOString()
    });

    setResults(prev => prev.map(r => r.id === result.id ? { ...r, status: 'applied', applied_pattern: pattern.pattern_key } : r));
  };

  const handleDismiss = async (result) => {
    await base44.entities.PatientAnalysisResult.update(result.id, {
      status: 'dismissed',
      reviewed_at: new Date().toISOString()
    });
    setResults(prev => prev.map(r => r.id === result.id ? { ...r, status: 'dismissed' } : r));
  };

  const filtered = results.filter(r => {
    if (filterStatus !== 'all' && r.status !== filterStatus) return false;
    if (filterStore !== 'all' && r.store_id !== filterStore) return false;
    if (filterType !== 'all' && r.result_type !== filterType) return false;
    return true;
  });

  const pendingCount = results.filter(r => r.status === 'pending_review').length;

  return (
    <div className="max-w-4xl mx-auto p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
            <Activity className="w-6 h-6 text-blue-600" />
            Patient Activity Review
          </h1>
          <p className="text-sm text-slate-500 mt-0.5">
            AI-detected inactivity and recurring pattern suggestions
          </p>
        </div>
        <div className="flex gap-2 flex-wrap items-center">
          <Select onValueChange={(v) => handleRunScan(v)} disabled={scanning}>
            <SelectTrigger className="w-44 h-9 text-sm">
              <SelectValue placeholder={scanning ? 'Scanning...' : 'Run Scan for Store'} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Stores (Today's)</SelectItem>
              {stores.map(s => (
                <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" variant="outline" onClick={loadData} disabled={loading}>
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      {scanMessage && (
        <div className={`text-sm rounded-md p-3 ${scanMessage.startsWith('Error') ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700'}`}>
          {scanMessage}
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3">
        <Card className="border-yellow-200 bg-yellow-50/50">
          <CardContent className="p-3 text-center">
            <div className="text-2xl font-bold text-yellow-700">{results.filter(r => r.status === 'pending_review').length}</div>
            <div className="text-xs text-yellow-600">Pending Review</div>
          </CardContent>
        </Card>
        <Card className="border-red-200 bg-red-50/50">
          <CardContent className="p-3 text-center">
            <div className="text-2xl font-bold text-red-700">{results.filter(r => r.result_type === 'inactivity_flagged').length}</div>
            <div className="text-xs text-red-600">Marked Inactive</div>
          </CardContent>
        </Card>
        <Card className="border-blue-200 bg-blue-50/50">
          <CardContent className="p-3 text-center">
            <div className="text-2xl font-bold text-blue-700">{results.filter(r => r.result_type !== 'inactivity_flagged').length}</div>
            <div className="text-xs text-blue-600">Pattern Results</div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <div className="flex gap-2 flex-wrap">
        <Select value={filterStatus} onValueChange={setFilterStatus}>
          <SelectTrigger className="w-40 h-8 text-xs">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="pending_review">Pending Review</SelectItem>
            <SelectItem value="applied">Applied</SelectItem>
            <SelectItem value="dismissed">Dismissed</SelectItem>
          </SelectContent>
        </Select>
        <Select value={filterStore} onValueChange={setFilterStore}>
          <SelectTrigger className="w-40 h-8 text-xs">
            <SelectValue placeholder="Store" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Stores</SelectItem>
            {stores.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={filterType} onValueChange={setFilterType}>
          <SelectTrigger className="w-44 h-8 text-xs">
            <SelectValue placeholder="Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Types</SelectItem>
            <SelectItem value="inactivity_flagged">Inactivity</SelectItem>
            <SelectItem value="pattern_detected">Pattern Detected</SelectItem>
            <SelectItem value="pattern_ambiguous">Ambiguous Pattern</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Results List */}
      {loading ? (
        <div className="text-center py-12 text-slate-400">Loading...</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 text-slate-400">No results found for these filters.</div>
      ) : (
        <div className="space-y-2">
          {filtered.map(result => (
            <PatientResultCard
              key={result.id}
              result={result}
              stores={stores}
              onApply={handleApply}
              onDismiss={handleDismiss}
            />
          ))}
        </div>
      )}
    </div>
  );
}