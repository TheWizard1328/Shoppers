import React, { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Shield, CheckCircle, XCircle, Clock, RefreshCw, FileText, User } from 'lucide-react';

export default function DocAccessRequestsPanel({ currentUser }) {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(null); // request_id being approved/denied
  const [filter, setFilter] = useState('pending'); // pending | approved | denied | all

  const loadRequests = useCallback(async () => {
    setLoading(true);
    try {
      let result;
      if (filter === 'all') {
        result = await base44.entities.DocAccessRequest.list({
          sort: '-requested_at',
          limit: 100
        });
      } else {
        result = await base44.entities.DocAccessRequest.list({
          filter: { status: filter },
          sort: '-requested_at',
          limit: 100
        });
      }
      setRequests(result || []);
    } catch (err) {
      console.error('Failed to load requests:', err);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    loadRequests();
    const interval = setInterval(loadRequests, 30000);
    return () => clearInterval(interval);
  }, [loadRequests]);

  const handleApprove = async (requestId) => {
    setActing(requestId);
    try {
      await base44.functions.invoke('approveDocAccess', {
        request_id: requestId,
        action: 'approve'
      });
      await loadRequests();
    } catch (err) {
      console.error('Approve failed:', err);
      alert('Failed to approve: ' + (err.message || ''));
    } finally {
      setActing(null);
    }
  };

  const handleDeny = async (requestId) => {
    setActing(requestId);
    try {
      await base44.functions.invoke('approveDocAccess', {
        request_id: requestId,
        action: 'deny'
      });
      await loadRequests();
    } catch (err) {
      console.error('Deny failed:', err);
      alert('Failed to deny: ' + (err.message || ''));
    } finally {
      setActing(null);
    }
  };

  const handleRevoke = async (request) => {
    if (!confirm(`Revoke access for ${request.requester_name}?`)) return;
    setActing(request.id);
    try {
      await base44.entities.DocAccessRequest.update(request.id, {
        status: 'revoked',
        revoked_at: new Date().toISOString(),
        revoked_by: currentUser?.id
      });

      // Audit log
      await base44.entities.DocAuditLog.create({
        viewer_id: currentUser?.id,
        viewer_name: currentUser?.full_name || currentUser?.email,
        action: 'revoked',
        driver_id: request.driver_id,
        driver_name: request.driver_name,
        viewed_at: new Date().toISOString(),
        user_agent: navigator.userAgent
      });

      await loadRequests();
    } catch (err) {
      console.error('Revoke failed:', err);
      alert('Failed to revoke: ' + (err.message || ''));
    } finally {
      setActing(null);
    }
  };

  const formatTime = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleString('en-US', {
      month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit'
    });
  };

  const isAccessActive = (req) => {
    if (req.status !== 'approved') return false;
    const now = new Date();
    if (req.expires_at && now > new Date(req.expires_at)) return false;
    if (req.first_viewed_at) {
      const viewTime = new Date(req.first_viewed_at);
      const expiry = new Date(viewTime.getTime() + 30 * 60 * 1000);
      if (now > expiry) return false;
    }
    return true;
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Shield className="w-5 h-5 text-blue-600" />
          <h3 className="font-semibold text-slate-900">Document Access Requests</h3>
        </div>
        <div className="flex items-center gap-2">
          {/* Filter buttons */}
          <div className="flex gap-1 bg-slate-100 rounded-lg p-1">
            {['pending', 'approved', 'denied', 'all'].map(f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-3 py-1 rounded-md text-xs font-medium capitalize transition-colors ${
                  filter === f ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                {f}
              </button>
            ))}
          </div>
          <Button onClick={loadRequests} variant="ghost" size="sm" disabled={loading}>
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      {/* Pending count badge */}
      {filter === 'pending' && requests.length > 0 && (
        <div className="flex items-center gap-2 text-sm">
          <Badge className="bg-amber-100 text-amber-800">
            {requests.length} pending
          </Badge>
          <span className="text-slate-500">Review and approve or deny document access requests from dispatchers.</span>
        </div>
      )}

      {/* Request list */}
      {loading ? (
        <div className="text-center py-8 text-sm text-slate-500">Loading requests...</div>
      ) : requests.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-slate-500">
            No {filter !== 'all' ? filter : ''} requests found.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {requests.map((req) => (
            <Card key={req.id} className="hover:shadow-sm transition-shadow">
              <CardContent className="p-3 sm:p-4">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  {/* Left: Requester info */}
                  <div className="flex items-start gap-3 flex-1 min-w-0">
                    <div className="w-9 h-9 rounded-lg bg-slate-100 flex items-center justify-center flex-shrink-0">
                      <User className="w-4 h-4 text-slate-500" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-sm text-slate-900">
                          {req.requester_name || 'Unknown'}
                        </span>
                        <span className="text-xs text-slate-400">requested access to</span>
                        <span className="font-medium text-sm text-slate-700">
                          {req.driver_name || 'Unknown Driver'}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 flex-wrap mt-1">
                        <span className="text-xs text-slate-400">
                          {formatTime(req.requested_at)}
                        </span>
                        <StatusBadge status={req.status} active={isAccessActive(req)} />
                        {req.approved_by_name && (
                          <span className="text-xs text-slate-400">
                            by {req.approved_by_name}
                          </span>
                        )}
                        {req.first_viewed_at && (
                          <span className="text-xs text-slate-400">
                            • viewed {formatTime(req.first_viewed_at)}
                          </span>
                        )}
                        {req.expires_at && isAccessActive(req) && (
                          <span className="text-xs text-amber-600">
                            • expires {formatTime(req.expires_at)}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Right: Action buttons */}
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {req.status === 'pending' && (
                      <>
                        <Button
                          onClick={() => handleApprove(req.id)}
                          disabled={acting === req.id}
                          size="sm"
                          className="gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white h-8"
                        >
                          <CheckCircle className="w-3.5 h-3.5" />
                          Approve
                        </Button>
                        <Button
                          onClick={() => handleDeny(req.id)}
                          disabled={acting === req.id}
                          size="sm"
                          variant="outline"
                          className="gap-1.5 h-8 text-red-600 border-red-200 hover:bg-red-50"
                        >
                          <XCircle className="w-3.5 h-3.5" />
                          Deny
                        </Button>
                      </>
                    )}
                    {isAccessActive(req) && (
                      <Button
                        onClick={() => handleRevoke(req)}
                        disabled={acting === req.id}
                        size="sm"
                        variant="outline"
                        className="gap-1.5 h-8 text-orange-600 border-orange-200 hover:bg-orange-50"
                      >
                        <XCircle className="w-3.5 h-3.5" />
                        Revoke
                      </Button>
                    )}
                    {acting === req.id && (
                      <div className="w-4 h-4 border-2 border-slate-200 border-t-slate-800 rounded-full animate-spin" />
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status, active }) {
  if (status === 'pending') return <Badge className="bg-amber-100 text-amber-800 text-xs">Pending</Badge>;
  if (status === 'approved' && active) return <Badge className="bg-emerald-100 text-emerald-800 text-xs">Active</Badge>;
  if (status === 'approved' && !active) return <Badge className="bg-slate-100 text-slate-500 text-xs">Expired</Badge>;
  if (status === 'denied') return <Badge className="bg-red-100 text-red-700 text-xs">Denied</Badge>;
  if (status === 'revoked') return <Badge className="bg-orange-100 text-orange-800 text-xs">Revoked</Badge>;
  if (status === 'expired') return <Badge className="bg-slate-100 text-slate-500 text-xs">Expired</Badge>;
  return <Badge variant="outline" className="text-xs">{status}</Badge>;
}
