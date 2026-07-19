import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useDevice } from '@/components/utils/DeviceContext';
import { useAppData } from '../components/utils/AppDataContext';
import { useUser } from '../components/utils/UserContext';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  FileText, Shield, ShieldCheck, CheckCircle, XCircle, Clock, Upload, Camera,
  Search, RefreshCw, Trash2, Eye, AlertTriangle, Building2, User, Lock, ChevronRight
} from 'lucide-react';
import { getDriverDisplayName } from '../components/utils/driverUtils';
import { sortUsers } from '../components/utils/sorting';
import { formatPhoneNumber } from '../components/utils/phoneFormatter';
import { createPageUrl } from '../utils';

const DOC_TYPES = [
  { key: 'license', label: "Driver's License", icon: FileText },
  { key: 'background_check', label: 'Background Check', icon: ShieldCheck },
  { key: 'contract', label: 'Driver Contract', icon: Building2 },
];

const REQUESTABLE_DOC_TYPES = [
  { key: 'license', label: "Driver's License" },
  { key: 'background_check', label: 'Background Check' },
];

function formatDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
  });
}

function isAccessActive(req) {
  if (req.status !== 'approved') return false;
  const now = new Date();
  if (req.expires_at && now > new Date(req.expires_at)) return false;
  if (req.first_viewed_at) {
    const viewTime = new Date(req.first_viewed_at);
    const expiry = new Date(viewTime.getTime() + 30 * 60 * 1000);
    if (now > expiry) return false;
  }
  return true;
}

function getTimeRemaining(req) {
  if (!isAccessActive(req)) return null;
  const now = new Date();
  const expires = [];
  if (req.expires_at) expires.push(new Date(req.expires_at));
  if (req.first_viewed_at) {
    expires.push(new Date(new Date(req.first_viewed_at).getTime() + 30 * 60 * 1000));
  }
  if (expires.length === 0) return null;
  const nearest = expires.reduce((a, b) => (a < b ? a : b));
  const ms = nearest - now;
  if (ms <= 0) return 'expired';
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}

export default function Documents() {
  const { isMobile } = useDevice();
  const { currentUser } = useUser();
  const { users, appUsers, stores } = useAppData();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [documents, setDocuments] = useState([]);
  const [accessRequests, setAccessRequests] = useState([]);
  const [selectedDriverIds, setSelectedDriverIds] = useState(new Set());
  const [selectedDocTypes, setSelectedDocTypes] = useState(new Set(['license', 'background_check']));
  const [includeContract, setIncludeContract] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [viewingDoc, setViewingDoc] = useState(null);
  const [docUrl, setDocUrl] = useState(null);
  const [docLoading, setDocLoading] = useState(false);
  const [uploadingForDriver, setUploadingForDriver] = useState(null);
  const [uploadingContract, setUploadingContract] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [actionLoading, setActionLoading] = useState(null);
  const [activeTab, setActiveTab] = useState('request'); // 'request' | 'pending' | 'approved' | 'mydocs' | 'upload'
  const fileInputRef = useRef(null);
  const cameraInputRef = useRef(null);
  const contractFileRef = useRef(null);
  const contractCameraRef = useRef(null);

  const isAdmin = currentUser?.app_roles?.includes('admin');
  const isDispatcher = currentUser?.app_roles?.includes('dispatcher');
  const isDriver = currentUser?.app_roles?.includes('driver');

  // Build driver list
  const drivers = useMemo(() => {
    const seen = new Set();
    const driverUsers = (users || []).filter((u) => {
      if (!u?.app_roles?.includes('driver')) return false;
      if (seen.has(u.id)) return false;
      seen.add(u.id);
      return true;
    });

    // Dispatchers only see drivers from their store
    if (isDispatcher && !isAdmin) {
      const dispatcherStoreIds = currentUser?.store_ids || [];
      return sortUsers(driverUsers.filter((d) => {
        const dStoreIds = d.store_ids || [];
        return dStoreIds.some(sid => dispatcherStoreIds.includes(sid));
      }));
    }
    return sortUsers(driverUsers);
  }, [users, currentUser, isAdmin, isDispatcher]);

  const filteredDrivers = useMemo(() => {
    if (!searchQuery.trim()) return drivers;
    const q = searchQuery.toLowerCase();
    return drivers.filter((d) => {
      const name = getDriverDisplayName(d)?.toLowerCase() || '';
      return name.includes(q) || d.email?.toLowerCase().includes(q);
    });
  }, [drivers, searchQuery]);

  // Get dispatcher's store(s)
  const dispatcherStores = useMemo(() => {
    const storeIds = currentUser?.store_ids || [];
    return (stores || []).filter(s => storeIds.includes(s?.id));
  }, [stores, currentUser]);

  const loadData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setRefreshing(true);
    try {
      const me = await base44.auth.me();
      if (!me) return;

      // Load documents
      let allDocs = [];
      if (isDriver) {
        // Driver sees their own docs + store contracts for their store
        const myDocs = await base44.entities.DriverDocument.list({
          filter: { driver_id: me.id, document_scope: 'driver' },
          limit: 100
        });
        allDocs.push(...(myDocs || []));

        // Store contracts for their stores
        const myStoreIds = me.store_ids || [];
        for (const sid of myStoreIds) {
          const contracts = await base44.entities.DriverDocument.list({
            filter: { store_id: sid, document_scope: 'store', document_type: 'contract' },
            limit: 10
          });
          allDocs.push(...(contracts || []));
        }
      } else {
        // Dispatcher/Admin: see store contracts + driver docs they have access to
        const myStoreIds = me.store_ids || [];

        // Store contracts
        for (const sid of myStoreIds) {
          const contracts = await base44.entities.DriverDocument.list({
            filter: { store_id: sid, document_scope: 'store', document_type: 'contract' },
            limit: 10
          });
          allDocs.push(...(contracts || []));
        }

        // Admin can see all driver docs
        if (isAdmin) {
          const allDriverDocs = await base44.entities.DriverDocument.list({
            filter: { document_scope: 'driver' },
            limit: 500,
            sort: '-uploaded_at'
          });
          allDocs.push(...(allDriverDocs || []));
        }
      }

      setDocuments(allDocs);

      // Load access requests
      let requests = [];
      if (isDispatcher && !isAdmin) {
        // Dispatcher sees their own requests
        requests = await base44.entities.DocAccessRequest.list({
          filter: { requester_id: me.id },
          sort: '-requested_at',
          limit: 100
        });
      } else if (isDriver && !isAdmin) {
        // Driver sees requests for their documents
        requests = await base44.entities.DocAccessRequest.list({
          filter: { driver_id: me.id },
          sort: '-requested_at',
          limit: 100
        });
      } else if (isAdmin) {
        // Admin sees all requests
        requests = await base44.entities.DocAccessRequest.list({
          sort: '-requested_at',
          limit: 200
        });
      }
      setAccessRequests(requests || []);
    } catch (err) {
      console.error('[Documents] Failed to load:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [isAdmin, isDispatcher, isDriver]);

  useEffect(() => {
    loadData();
    const interval = setInterval(() => loadData(true), 30000);
    return () => clearInterval(interval);
  }, [loadData]);

  // Get documents for a specific driver
  const getDriverDocs = useCallback((driverId) => {
    return documents.filter(d => d.driver_id === driverId && d.document_scope === 'driver');
  }, [documents]);

  // Get store contracts
  const getStoreContracts = useCallback((storeId) => {
    return documents.filter(d => d.store_id === storeId && d.document_scope === 'store' && d.document_type === 'contract');
  }, [documents]);

  // Toggle driver selection
  const toggleDriver = (driverId) => {
    setSelectedDriverIds(prev => {
      const next = new Set(prev);
      if (next.has(driverId)) next.delete(driverId);
      else next.add(driverId);
      return next;
    });
  };

  // Toggle doc type selection
  const toggleDocType = (docKey) => {
    setSelectedDocTypes(prev => {
      const next = new Set(prev);
      if (next.has(docKey)) next.delete(docKey);
      else next.add(docKey);
      return next;
    });
  };

  // Submit document request
  const submitRequest = async () => {
    if (selectedDriverIds.size === 0) return;
    const docTypes = Array.from(selectedDocTypes);
    if (docTypes.length === 0) return;

    setSubmitting(true);
    try {
      const driverIds = Array.from(selectedDriverIds);
      const driverNames = driverIds.map(id => {
        const d = drivers.find(dr => dr.id === id);
        return getDriverDisplayName(d) || id;
      });

      await base44.functions.invoke('docAccessManager', {
        action: 'createRequest',
        driver_ids: driverIds,
        driver_names: driverNames,
        requested_doc_types: docTypes,
      });

      setSelectedDriverIds(new Set());
      setSelectedDocTypes(new Set(['license', 'background_check']));
      setIncludeContract(false);
      await loadData(true);
    } catch (err) {
      console.error('Request failed:', err);
      alert('Failed to submit request: ' + (err.message || ''));
    } finally {
      setSubmitting(false);
    }
  };

  // Approve request
  const handleApprove = async (requestId) => {
    setActionLoading(requestId);
    try {
      await base44.functions.invoke('docAccessManager', {
        action: 'approve',
        request_id: requestId,
      });
      await loadData(true);
    } catch (err) {
      console.error('Approve failed:', err);
      alert('Failed to approve: ' + (err.message || ''));
    } finally {
      setActionLoading(null);
    }
  };

  // Deny request
  const handleDeny = async (requestId) => {
    setActionLoading(requestId);
    try {
      await base44.functions.invoke('docAccessManager', {
        action: 'deny',
        request_id: requestId,
      });
      await loadData(true);
    } catch (err) {
      console.error('Deny failed:', err);
      alert('Failed to deny: ' + (err.message || ''));
    } finally {
      setActionLoading(null);
    }
  };

  // View a document
  const handleViewDoc = async (doc) => {
    setDocLoading(true);
    setViewingDoc(doc);
    setDocUrl(null);
    try {
      const me = await base44.auth.me();
      const resp = await base44.functions.invoke('serveDriverDoc', {
        doc_id: doc.id,
        viewer_id: me.id,
        viewer_name: me.full_name || me.email || 'Unknown',
      });

      // Set first_viewed_at for access requests
      if (!isAdmin) {
        const activeReq = accessRequests.find(r =>
          r.driver_id === doc.driver_id &&
          r.status === 'approved' &&
          !r.first_viewed_at &&
          isAccessActive(r)
        );
        if (activeReq) {
          try {
            await base44.entities.DocAccessRequest.update(activeReq.id, {
              first_viewed_at: new Date().toISOString()
            });
          } catch (_) {}
        }
      }

      const data = resp?.data || resp;
      setDocUrl(data?.file_url || null);
      await loadData(true);
    } catch (err) {
      console.error('View doc failed:', err);
      alert('Failed to load document: ' + (err.message || ''));
    } finally {
      setDocLoading(false);
    }
  };

  // Upload document (driver self-upload)
  const handleUploadFile = async (file, docType, driverId, driverName, scope = 'driver', storeId = null, storeName = null) => {
    if (!file) return;
    setUploadingForDriver(docType + driverId);
    try {
      // Upload to private storage
      const formData = new FormData();
      formData.append('file', file);
      const uploadResp = await base44.files.upload(file, { private: true });
      const fileUri = uploadResp?.uri || uploadResp?.file_uri || uploadResp;

      await base44.functions.invoke('docAccessManager', {
        action: 'uploadDocument',
        document_type: docType,
        document_scope: scope,
        driver_id: driverId,
        driver_name: driverName,
        store_id: storeId,
        store_name: storeName,
        file_uri: fileUri,
        file_size: file.size,
        mime_type: file.type || 'image/jpeg',
      });

      await loadData(true);
    } catch (err) {
      console.error('Upload failed:', err);
      alert('Upload failed: ' + (err.message || ''));
    } finally {
      setUploadingForDriver(null);
    }
  };

  // Handle file input for driver doc upload
  const handleDriverFileInput = (e, docType) => {
    const file = e.target.files?.[0];
    if (file) {
      handleUploadFile(file, docType, currentUser.id, getDriverDisplayName(currentUser), 'driver');
    }
    e.target.value = '';
  };

  // Handle file input for contract upload
  const handleContractFileInput = (e, storeId, storeName) => {
    const file = e.target.files?.[0];
    if (file) {
      handleUploadFile(file, 'contract', null, null, 'store', storeId, storeName);
    }
    e.target.value = '';
  };

  // Delete a document
  const handleDeleteDoc = async (docId) => {
    if (!confirm('Delete this document? This cannot be undone.')) return;
    setActionLoading('delete-' + docId);
    try {
      await base44.functions.invoke('docAccessManager', {
        action: 'deleteDocument',
        doc_id: docId,
      });
      await loadData(true);
      if (viewingDoc?.id === docId) {
        setViewingDoc(null);
        setDocUrl(null);
      }
    } catch (err) {
      console.error('Delete failed:', err);
      alert('Failed to delete: ' + (err.message || ''));
    } finally {
      setActionLoading(null);
    }
  };

  // Get driver's pending incoming requests (for driver view)
  const myPendingRequests = useMemo(() => {
    if (!isDriver || isAdmin) return [];
    return accessRequests.filter(r => r.status === 'pending' && r.driver_id === currentUser?.id);
  }, [accessRequests, isDriver, isAdmin, currentUser]);

  // Get dispatcher's active approved requests
  const myActiveAccess = useMemo(() => {
    if (!isDispatcher && !isAdmin) return [];
    return accessRequests.filter(r => isAccessActive(r));
  }, [accessRequests, isDispatcher, isAdmin]);

  // Pending requests for admin to review
  const allPendingRequests = useMemo(() => {
    if (!isAdmin) return [];
    return accessRequests.filter(r => r.status === 'pending');
  }, [accessRequests, isAdmin]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="w-8 h-8 border-2 border-slate-200 border-t-slate-800 rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <Shield className="w-6 h-6 text-blue-600" />
          <h1 className="text-xl font-bold">Documents</h1>
          <Badge variant="secondary" className="ml-2">
            {documents.length} files
          </Badge>
        </div>
        <Button onClick={() => loadData()} variant="ghost" size="sm" disabled={refreshing}>
          <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {/* === DRIVER VIEW === */}
      {isDriver && !isAdmin && (
        <div className="space-y-4">
          {/* Incoming access requests */}
          {myPendingRequests.length > 0 && (
            <Card className="border-amber-200 bg-amber-50">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Clock className="w-4 h-4 text-amber-600" />
                  Access Requests ({myPendingRequests.length})
                </CardTitle>
                <CardDescription>Dispatchers are requesting to view your documents</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {myPendingRequests.map(req => (
                  <div key={req.id} className="flex items-center justify-between gap-3 p-3 bg-card rounded-lg border">
                    <div className="min-w-0">
                      <p className="font-medium text-sm">{req.requester_name || 'Dispatcher'}</p>
                      <p className="text-xs text-muted-foreground">
                        wants to view: {(req.requested_doc_types || []).map(t => t.replace(/_/g, ' ')).join(', ')}
                      </p>
                      <p className="text-xs text-muted-foreground">{formatDateTime(req.requested_at)}</p>
                    </div>
                    <div className="flex gap-2 flex-shrink-0">
                      <Button size="sm" onClick={() => handleApprove(req.id)} disabled={actionLoading === req.id}
                        className="bg-emerald-600 hover:bg-emerald-700 text-white gap-1.5 h-8">
                        <CheckCircle className="w-3.5 h-3.5" /> Approve
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => handleDeny(req.id)} disabled={actionLoading === req.id}
                        className="text-red-600 border-red-200 hover:bg-red-50 gap-1.5 h-8">
                        <XCircle className="w-3.5 h-3.5" /> Deny
                      </Button>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {/* My documents — upload area */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <FileText className="w-4 h-4" /> My Documents
              </CardTitle>
              <CardDescription>Upload your driver's license and background check</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {REQUESTABLE_DOC_TYPES.map(({ key, label }) => {
                const existingDoc = documents.find(d => d.document_type === key && d.driver_id === currentUser?.id);
                return (
                  <div key={key} className="flex items-center justify-between gap-3 p-3 border rounded-lg">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-10 h-10 rounded-lg bg-slate-100 flex items-center justify-center flex-shrink-0">
                        {existingDoc ? <CheckCircle className="w-5 h-5 text-emerald-600" /> : <FileText className="w-5 h-5 text-slate-400" />}
                      </div>
                      <div className="min-w-0">
                        <p className="font-medium text-sm">{label}</p>
                        {existingDoc ? (
                          <p className="text-xs text-muted-foreground">
                            Uploaded {formatDateTime(existingDoc.uploaded_at)}
                            {existingDoc.document_expiry_date && ` • expires ${existingDoc.document_expiry_date}`}
                          </p>
                        ) : (
                          <p className="text-xs text-muted-foreground">Not uploaded</p>
                        )}
                      </div>
                    </div>
                    <div className="flex gap-1.5 flex-shrink-0">
                      <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" className="hidden"
                        onChange={(e) => handleDriverFileInput(e, key)} />
                      <input ref={fileInputRef} type="file" accept="image/*,application/pdf" className="hidden"
                        onChange={(e) => handleDriverFileInput(e, key)} />
                      <Button size="sm" variant="outline" onClick={() => cameraInputRef.current?.click()}
                        disabled={uploadingForDriver === key + currentUser?.id} className="gap-1.5 h-8">
                        {uploadingForDriver === key + currentUser?.id ?
                          <div className="w-3.5 h-3.5 border-2 border-slate-200 border-t-slate-800 rounded-full animate-spin" /> :
                          <Camera className="w-3.5 h-3.5" />}
                        Photo
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => fileInputRef.current?.click()}
                        disabled={uploadingForDriver === key + currentUser?.id} className="gap-1.5 h-8">
                        <Upload className="w-3.5 h-3.5" /> File
                      </Button>
                      {existingDoc && (
                        <Button size="sm" variant="ghost" onClick={() => handleViewDoc(existingDoc)} className="h-8">
                          <Eye className="w-3.5 h-3.5" />
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>

          {/* Store contracts (read-only) */}
          {(currentUser?.store_ids || []).length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Building2 className="w-4 h-4" /> Store Contracts
                </CardTitle>
                <CardDescription>Contracts for your assigned stores</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {(currentUser?.store_ids || []).map(sid => {
                  const store = stores?.find(s => s?.id === sid);
                  const contracts = getStoreContracts(sid);
                  return (
                    <div key={sid} className="p-3 border rounded-lg">
                      <p className="text-sm font-medium mb-1">{store?.name || 'Unknown Store'}</p>
                      {contracts.length === 0 ? (
                        <p className="text-xs text-muted-foreground">No contract uploaded</p>
                      ) : (
                        contracts.map(c => (
                          <div key={c.id} className="flex items-center justify-between gap-2 mt-2">
                            <span className="text-xs text-muted-foreground">
                              {formatDateTime(c.uploaded_at)}
                              {c.document_expiry_date && ` • expires ${c.document_expiry_date}`}
                            </span>
                            <Button size="sm" variant="ghost" onClick={() => handleViewDoc(c)} className="h-7">
                              <Eye className="w-3.5 h-3.5" /> View
                            </Button>
                          </div>
                        ))
                      )}
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* === DISPATCHER / ADMIN VIEW === */}
      {(isDispatcher || isAdmin) && (
        <div className="space-y-4">
          {/* Pending requests (admin sees all, dispatcher sees their own outgoing) */}
          {(allPendingRequests.length > 0 || myActiveAccess.length > 0) && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Clock className="w-4 h-4 text-amber-600" />
                  {isAdmin ? 'All Access Requests' : 'My Access Requests'}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {/* Admin: pending requests to approve */}
                {isAdmin && allPendingRequests.map(req => (
                  <div key={req.id} className="flex items-center justify-between gap-3 p-3 border rounded-lg bg-amber-50/50">
                    <div className="min-w-0">
                      <p className="font-medium text-sm">
                        {req.requester_name} → {req.driver_name}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {(req.requested_doc_types || []).map(t => t.replace(/_/g, ' ')).join(', ')} • {formatDateTime(req.requested_at)}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => handleApprove(req.id)} disabled={actionLoading === req.id}
                        className="bg-emerald-600 hover:bg-emerald-700 text-white gap-1.5 h-8">
                        <CheckCircle className="w-3.5 h-3.5" /> Approve
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => handleDeny(req.id)} disabled={actionLoading === req.id}
                        className="text-red-600 border-red-200 hover:bg-red-50 gap-1.5 h-8">
                        <XCircle className="w-3.5 h-3.5" /> Deny
                      </Button>
                    </div>
                  </div>
                ))}

                {/* Active approved access with countdown */}
                {myActiveAccess.map(req => (
                  <div key={req.id} className="flex items-center justify-between gap-3 p-3 border rounded-lg bg-emerald-50/50">
                    <div className="min-w-0">
                      <p className="font-medium text-sm flex items-center gap-2">
                        {req.driver_name}
                        <Badge className="bg-emerald-100 text-emerald-800 text-xs">Approved</Badge>
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {(req.requested_doc_types || []).map(t => t.replace(/_/g, ' ')).join(', ')}
                        {req.first_viewed_at && ' • viewed ' + formatDateTime(req.first_viewed_at)}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {getTimeRemaining(req) && (
                        <Badge variant="outline" className="text-xs gap-1">
                          <Clock className="w-3 h-3" /> {getTimeRemaining(req)}
                        </Badge>
                      )}
                      <Button size="sm" variant="outline" onClick={() => {
                        const driverDocs = getDriverDocs(req.driver_id).filter(d =>
                          (req.requested_doc_types || []).includes(d.document_type)
                        );
                        if (driverDocs.length > 0) handleViewDoc(driverDocs[0]);
                      }} className="h-8 gap-1.5">
                        <Eye className="w-3.5 h-3.5" /> View
                      </Button>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {/* Driver selection + request section */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base">Request Document Access</CardTitle>
                  <CardDescription>Select drivers and document types to request</CardDescription>
                </div>
                <div className="flex items-center gap-2">
                  <div className="relative">
                    <Search className="w-4 h-4 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
                    <Input type="text" placeholder="Search drivers..." value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="pl-8 w-40 sm:w-56 h-8 text-sm" />
                  </div>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {/* Doc type checkboxes */}
              <div className="flex items-center gap-4 flex-wrap">
                {REQUESTABLE_DOC_TYPES.map(({ key, label }) => (
                  <label key={key} className="flex items-center gap-2 cursor-pointer">
                    <Checkbox checked={selectedDocTypes.has(key)} onCheckedChange={() => toggleDocType(key)} />
                    <span className="text-sm">{label}</span>
                  </label>
                ))}
                <label className="flex items-center gap-2 cursor-pointer">
                  <Checkbox checked={includeContract} onCheckedChange={() => setIncludeContract(!includeContract)} />
                  <span className="text-sm">Include Contract (no approval needed)</span>
                </label>
              </div>

              {/* Driver list */}
              <div className="max-h-60 overflow-y-auto space-y-1 border rounded-lg p-2">
                {filteredDrivers.length === 0 ? (
                  <p className="text-center text-sm text-muted-foreground py-4">No drivers found</p>
                ) : (
                  filteredDrivers.map(driver => {
                    const isSelected = selectedDriverIds.has(driver.id);
                    const driverDocs = getDriverDocs(driver.id);
                    const hasLicense = driverDocs.some(d => d.document_type === 'license');
                    const hasBg = driverDocs.some(d => d.document_type === 'background_check');
                    return (
                      <div key={driver.id}
                        className={`flex items-center gap-3 p-2 rounded-lg cursor-pointer transition-colors ${
                          isSelected ? 'bg-blue-50 border border-blue-200' : 'hover:bg-muted'
                        }`}
                        onClick={() => toggleDriver(driver.id)}>
                        <Checkbox checked={isSelected} onCheckedChange={() => {}} />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium">{getDriverDisplayName(driver)}</p>
                          <p className="text-xs text-muted-foreground">
                            {hasLicense ? '✓' : '✗'} License • {hasBg ? '✓' : '✗'} Background Check
                          </p>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              {/* Request button */}
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm text-muted-foreground">
                  {selectedDriverIds.size > 0 ? `${selectedDriverIds.size} driver(s) selected` : 'Select drivers above'}
                </span>
                <Button onClick={submitRequest} disabled={submitting || selectedDriverIds.size === 0 || selectedDocTypes.size === 0}
                  className="gap-2">
                  {submitting ? (
                    <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  ) : (
                    <Shield className="w-4 h-4" />
                  )}
                  Request Documents
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Contract upload section */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Building2 className="w-4 h-4" /> Store Contracts
              </CardTitle>
              <CardDescription>Upload and manage driver contracts for your stores</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {(dispatcherStores.length > 0 ? dispatcherStores : (isAdmin ? stores : [])).map(store => {
                const contracts = getStoreContracts(store?.id);
                return (
                  <div key={store?.id} className="p-3 border rounded-lg">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-medium text-sm">{store?.name}</p>
                      <div className="flex gap-1.5">
                        <input ref={contractCameraRef} type="file" accept="image/*" capture="environment" className="hidden"
                          onChange={(e) => handleContractFileInput(e, store?.id, store?.name)} />
                        <input ref={contractFileRef} type="file" accept="image/*,application/pdf" className="hidden"
                          onChange={(e) => handleContractFileInput(e, store?.id, store?.name)} />
                        <Button size="sm" variant="outline" className="gap-1.5 h-8"
                          onClick={() => contractCameraRef.current?.click()}>
                          <Camera className="w-3.5 h-3.5" /> Photo
                        </Button>
                        <Button size="sm" variant="outline" className="gap-1.5 h-8"
                          onClick={() => contractFileRef.current?.click()}>
                          <Upload className="w-3.5 h-3.5" /> Upload
                        </Button>
                      </div>
                    </div>
                    {contracts.length === 0 ? (
                      <p className="text-xs text-muted-foreground mt-2">No contract uploaded</p>
                    ) : (
                      <div className="mt-2 space-y-1">
                        {contracts.map(c => (
                          <div key={c.id} className="flex items-center justify-between gap-2 text-xs">
                            <span className="text-muted-foreground">
                              Uploaded {formatDateTime(c.uploaded_at)} by {c.uploaded_by_name}
                              {c.document_expiry_date && ` • expires ${c.document_expiry_date}`}
                            </span>
                            <div className="flex gap-1">
                              <Button size="sm" variant="ghost" className="h-6" onClick={() => handleViewDoc(c)}>
                                <Eye className="w-3 h-3" />
                              </Button>
                              {(isAdmin || c.uploaded_by === currentUser?.id) && (
                                <Button size="sm" variant="ghost" className="h-6 text-red-600" disabled={actionLoading === 'delete-' + c.id}
                                  onClick={() => handleDeleteDoc(c.id)}>
                                  <Trash2 className="w-3 h-3" />
                                </Button>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </CardContent>
          </Card>

          {/* Document viewer (inline, right side on desktop / below on mobile) */}
          {viewingDoc && (
            <Card className="border-blue-200">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Lock className="w-4 h-4 text-blue-600" />
                    Viewing: {viewingDoc.document_type?.replace(/_/g, ' ')}
                    {viewingDoc.driver_name && ` — ${viewingDoc.driver_name}`}
                    {viewingDoc.store_name && ` — ${viewingDoc.store_name}`}
                  </CardTitle>
                  <Button size="sm" variant="ghost" onClick={() => { setViewingDoc(null); setDocUrl(null); }}>
                    <XCircle className="w-4 h-4" /> Close
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                {docLoading ? (
                  <div className="flex items-center justify-center h-64">
                    <div className="w-8 h-8 border-2 border-slate-200 border-t-slate-800 rounded-full animate-spin" />
                  </div>
                ) : docUrl ? (
                  <div className="relative">
                    {viewingDoc.mime_type?.includes('pdf') ? (
                      <iframe src={docUrl} className="w-full h-[70vh] border rounded-lg" title="Document" />
                    ) : (
                      <img src={docUrl} alt="Document" className="w-full max-h-[70vh] object-contain border rounded-lg"
                        style={{ pointerEvents: 'none' }} />
                    )}
                    {/* Watermark overlay */}
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                      <div className="text-white/20 font-bold text-2xl rotate-[-30deg] select-none">
                        CONFIDENTIAL
                      </div>
                    </div>
                  </div>
                ) : (
                  <p className="text-center text-sm text-muted-foreground py-8">Failed to load document</p>
                )}
              </CardContent>
            </Card>
          )}

          {/* Admin: all documents table */}
          {isAdmin && !viewingDoc && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">All Documents</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-1 max-h-80 overflow-y-auto">
                  {documents.filter(d => d.document_scope === 'driver').map(doc => (
                    <div key={doc.id} className="flex items-center justify-between gap-2 p-2 border rounded-lg text-sm">
                      <div className="flex items-center gap-2 min-w-0">
                        <FileText className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                        <span className="font-medium">{doc.driver_name || 'Unknown'}</span>
                        <span className="text-muted-foreground text-xs">{doc.document_type?.replace(/_/g, ' ')}</span>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <span className="text-xs text-muted-foreground">{formatDateTime(doc.uploaded_at)}</span>
                        <Button size="sm" variant="ghost" className="h-6" onClick={() => handleViewDoc(doc)}>
                          <Eye className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
