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
  // Crop modal state
  const [cropModal, setCropModal] = useState(null); // { src, file, docType, driverId, driverName, scope, storeId, storeName }
  const cropCanvasRef = useRef(null);
  const cropImageRef = useRef(null);
  const [cropDrag, setCropDrag] = useState(null);
  const [cropBox, setCropBox] = useState({ x: 0.05, y: 0.05, w: 0.9, h: 0.9 }); // relative 0-1

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

      // Driver (including driver+admin): load own driver-scoped docs
      if (isDriver) {
        const myDocs = await base44.entities.DriverDocument.list({
          filter: { driver_id: me.id, document_scope: 'driver' },
          limit: 100
        });
        allDocs.push(...(myDocs || []));
      }

      // Admin (including driver+admin): load ALL driver docs
      if (isAdmin) {
        const allDriverDocs = await base44.entities.DriverDocument.list({
          filter: { document_scope: 'driver' },
          limit: 500,
          sort: '-uploaded_at'
        });
        // Deduplicate against driver's own docs already loaded
        const seenIds = new Set(allDocs.map(d => d.id));
        for (const doc of (allDriverDocs || [])) {
          if (!seenIds.has(doc.id)) {
            allDocs.push(doc);
            seenIds.add(doc.id);
          }
        }
      }

      // Dispatcher (not admin, not driver): store contracts for their stores
      if (isDispatcher && !isAdmin && !isDriver) {
        const myStoreIds = me.store_ids || [];
        for (const sid of myStoreIds) {
          const contracts = await base44.entities.DriverDocument.list({
            filter: { store_id: sid, document_scope: 'store', document_type: 'contract' },
            limit: 10
          });
          allDocs.push(...(contracts || []));
        }
      }

      setDocuments(allDocs);

      // Load access requests
      let requests = [];
      if (isAdmin) {
        // Admin sees all requests
        requests = await base44.entities.DocAccessRequest.list({
          sort: '-requested_at',
          limit: 200
        });
      } else if (isDispatcher) {
        // Dispatcher sees their own outgoing requests
        requests = await base44.entities.DocAccessRequest.list({
          filter: { requester_id: me.id },
          sort: '-requested_at',
          limit: 100
        });
      } else if (isDriver) {
        // Driver sees requests targeting them
        requests = await base44.entities.DocAccessRequest.list({
          filter: { driver_id: me.id },
          sort: '-requested_at',
          limit: 100
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

  // Open crop modal for image files, direct upload for PDFs
  const openCropOrUpload = (file, docType, driverId, driverName, scope = 'driver', storeId = null, storeName = null) => {
    if (!file) return;
    if (file.size > 15 * 1024 * 1024) { alert('File too large. Maximum 15MB.'); return; }
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    if (!allowedTypes.includes(file.type)) { alert('Invalid file type. Use JPG, PNG, WebP, or PDF.'); return; }

    if (file.type === 'application/pdf') {
      // PDFs go straight to upload — no crop
      handleUploadFile(file, docType, driverId, driverName, scope, storeId, storeName);
      return;
    }

    // Images: show crop modal
    const reader = new FileReader();
    reader.onload = (ev) => {
      setCropBox({ x: 0.05, y: 0.05, w: 0.9, h: 0.9 });
      setCropModal({ src: ev.target.result, file, docType, driverId, driverName, scope, storeId, storeName });
    };
    reader.readAsDataURL(file);
  };

  // Upload document after optional crop
  const handleUploadFile = async (file, docType, driverId, driverName, scope = 'driver', storeId = null, storeName = null) => {
    if (!file) return;
    setUploadingForDriver(docType + (driverId || storeId || ''));
    try {
      // Use base44.integrations.Core.UploadFile — the correct client-side upload API
      const uploadResp = await base44.integrations.Core.UploadFile({ file });
      const fileUri = uploadResp?.file_url || uploadResp?.data?.file_url || uploadResp?.uri || uploadResp?.file_uri;
      if (!fileUri) throw new Error('Upload returned no file URL');

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
      alert('Upload failed: ' + (err.message || 'Unknown error'));
    } finally {
      setUploadingForDriver(null);
    }
  };

  // Confirm crop: draw cropped region to canvas and upload as blob
  const handleCropConfirm = async () => {
    if (!cropModal || !cropImageRef.current) return;
    const img = cropImageRef.current;
    const { x, y, w, h } = cropBox;
    const sw = img.naturalWidth * w;
    const sh = img.naturalHeight * h;
    const sx = img.naturalWidth * x;
    const sy = img.naturalHeight * y;

    const canvas = document.createElement('canvas');
    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);

    canvas.toBlob(async (blob) => {
      const ext = cropModal.file.name.split('.').pop() || 'jpg';
      const croppedFile = new File([blob], `cropped_${Date.now()}.${ext}`, { type: cropModal.file.type || 'image/jpeg' });
      const { docType, driverId, driverName, scope, storeId, storeName } = cropModal;
      setCropModal(null);
      await handleUploadFile(croppedFile, docType, driverId, driverName, scope, storeId, storeName);
    }, cropModal.file.type || 'image/jpeg', 0.92);
  };

  // Handle file input for driver doc upload
  const handleDriverFileInput = (e, docType) => {
    const file = e.target.files?.[0];
    if (file) {
      openCropOrUpload(file, docType, currentUser.id, getDriverDisplayName(currentUser), 'driver');
    }
    e.target.value = '';
  };

  // Handle file input for contract upload
  const handleContractFileInput = (e, storeId, storeName) => {
    const file = e.target.files?.[0];
    if (file) {
      openCropOrUpload(file, 'contract', null, null, 'store', storeId, storeName);
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
    if (!isDriver) return [];
    return accessRequests.filter(r => r.status === 'pending' && r.driver_id === currentUser?.id);
  }, [accessRequests, isDriver, isAdmin, currentUser]);

  // Get dispatcher's active approved requests
  const myActiveAccess = useMemo(() => {
    if (!isDispatcher) return [];
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
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header — fixed */}
      <div className="flex-shrink-0 px-4 sm:px-6 pt-4 pb-3 max-w-7xl w-full mx-auto">
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
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto px-4 sm:px-6 pb-6 max-w-7xl w-full mx-auto space-y-4">

      {/* === DRIVER SECTION === */}
      {isDriver && (
        <div className="space-y-4">
          {/* Incoming access requests (driver approves/denies) */}
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
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {existingDoc && (
                        <Button size="sm" variant="ghost" className="h-8" onClick={() => handleViewDoc(existingDoc)}>
                          <Eye className="w-3.5 h-3.5" />
                        </Button>
                      )}
                      <input ref={fileInputRef} type="file" className="hidden"
                        accept="image/jpeg,image/png,image/webp,application/pdf"
                        onChange={(e) => handleDriverFileInput(e, key)} />
                      <input ref={cameraInputRef} type="file" className="hidden"
                        accept="image/*" capture="environment"
                        onChange={(e) => handleDriverFileInput(e, key)} />
                      <Button size="sm" variant="outline" className="h-8 gap-1.5"
                        disabled={!!uploadingForDriver}
                        onClick={() => fileInputRef.current?.click()}>
                        <Upload className="w-3.5 h-3.5" />
                        {existingDoc ? 'Replace' : 'Upload'}
                      </Button>
                      {!isMobile && (
                        <Button size="sm" variant="ghost" className="h-8"
                          disabled={!!uploadingForDriver}
                          onClick={() => cameraInputRef.current?.click()}>
                          <Camera className="w-3.5 h-3.5" />
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
              {uploadingForDriver && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <div className="w-4 h-4 border-2 border-slate-200 border-t-slate-800 rounded-full animate-spin" />
                  Uploading...
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* === ADMIN SECTION (not dispatcher-only) === */}
      {isAdmin && (
        <div className="space-y-4">
          {/* Pending requests for admin to approve */}
          {allPendingRequests.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Clock className="w-4 h-4 text-amber-600" />
                  Access Requests to Review ({allPendingRequests.length})
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {allPendingRequests.map(req => (
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
              </CardContent>
            </Card>
          )}

          {/* All documents table */}
          {!viewingDoc && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">All Documents</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-1">
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
                        <Button size="sm" variant="ghost" className="h-6 text-red-600"
                          onClick={() => handleDeleteDoc(doc.id)} disabled={actionLoading === 'delete-' + doc.id}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </div>
                  ))}
                  {documents.filter(d => d.document_scope === 'driver').length === 0 && (
                    <p className="text-center text-sm text-muted-foreground py-4">No documents uploaded yet</p>
                  )}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* === DISPATCHER SECTION (dispatchers only, not admins) === */}
      {isDispatcher && !isAdmin && (
        <div className="space-y-4">
          {/* Active approved access */}
          {myActiveAccess.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4 text-emerald-600" />
                  Active Access ({myActiveAccess.length})
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
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
                            {hasLicense ? '\u2713' : '\u2717'} License • {hasBg ? '\u2713' : '\u2717'} Background Check
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
              <CardDescription>Upload and manage driver contracts for your store(s)</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {dispatcherStores.map(store => {
                const contracts = getStoreContracts(store.id);
                return (
                  <div key={store.id} className="p-3 border rounded-lg">
                    <div className="flex items-center justify-between gap-3 mb-2">
                      <p className="text-sm font-medium">{store?.name || 'Unknown Store'}</p>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <input ref={contractFileRef} type="file" className="hidden"
                          accept="image/jpeg,image/png,image/webp,application/pdf"
                          onChange={(e) => handleContractFileInput(e, store.id, store?.name)} />
                        <input ref={contractCameraRef} type="file" className="hidden"
                          accept="image/*" capture="environment"
                          onChange={(e) => handleContractFileInput(e, store.id, store?.name)} />
                        <Button size="sm" variant="outline" className="h-8 gap-1.5"
                          disabled={uploadingContract}
                          onClick={() => contractFileRef.current?.click()}>
                          <Upload className="w-3.5 h-3.5" /> Upload
                        </Button>
                        {!isMobile && (
                          <Button size="sm" variant="ghost" className="h-8"
                            disabled={uploadingContract}
                            onClick={() => contractCameraRef.current?.click()}>
                            <Camera className="w-3.5 h-3.5" />
                          </Button>
                        )}
                      </div>
                    </div>
                    {contracts.length === 0 ? (
                      <p className="text-xs text-muted-foreground">No contract uploaded</p>
                    ) : (
                      contracts.map(c => (
                        <div key={c.id} className="flex items-center justify-between gap-2 mt-2">
                          <span className="text-xs text-muted-foreground">
                            {formatDateTime(c.uploaded_at)}
                            {c.document_expiry_date && ` • expires ${c.document_expiry_date}`}
                          </span>
                          <div className="flex items-center gap-1">
                            <Button size="sm" variant="ghost" className="h-7" onClick={() => handleViewDoc(c)}>
                              <Eye className="w-3.5 h-3.5" /> View
                            </Button>
                            <Button size="sm" variant="ghost" className="h-7 text-red-600"
                              onClick={() => handleDeleteDoc(c.id)} disabled={actionLoading === 'delete-' + c.id}>
                              <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                );
              })}
              {uploadingContract && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <div className="w-4 h-4 border-2 border-slate-200 border-t-slate-800 rounded-full animate-spin" />
                  Uploading contract...
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* === Document Viewer Modal === */}
      {viewingDoc && (
        <Card className="fixed inset-4 z-50 bg-card shadow-2xl">
          <CardHeader className="pb-3 flex-shrink-0">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">
                {viewingDoc.document_type?.replace(/_/g, ' ')}
                {viewingDoc.driver_name && ` \u2014 ${viewingDoc.driver_name}`}
                {viewingDoc.store_name && ` \u2014 ${viewingDoc.store_name}`}
              </CardTitle>
              <Button size="sm" variant="ghost" onClick={() => { setViewingDoc(null); setDocUrl(null); }}>
                <XCircle className="w-4 h-4" /> Close
              </Button>
            </div>
          </CardHeader>
          <CardContent className="overflow-y-auto">
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

      {/* === CROP MODAL === */}
      {cropModal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setCropModal(null); }}>
          <div className="bg-card rounded-xl shadow-2xl w-full max-w-lg flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b">
              <p className="font-semibold text-sm">Adjust & Crop</p>
              <button className="text-muted-foreground hover:text-foreground" onClick={() => setCropModal(null)}>✕</button>
            </div>

            {/* Image with draggable crop overlay */}
            <div className="relative select-none overflow-hidden bg-black"
              style={{ maxHeight: '55vh' }}
              onPointerMove={(e) => {
                if (!cropDrag) return;
                const rect = e.currentTarget.getBoundingClientRect();
                const rx = (e.clientX - rect.left) / rect.width;
                const ry = (e.clientY - rect.top) / rect.height;
                if (cropDrag.type === 'move') {
                  const nx = Math.max(0, Math.min(rx - cropDrag.ox, 1 - cropBox.w));
                  const ny = Math.max(0, Math.min(ry - cropDrag.oy, 1 - cropBox.h));
                  setCropBox(b => ({ ...b, x: nx, y: ny }));
                } else if (cropDrag.type === 'resize') {
                  const nw = Math.max(0.1, Math.min(rx - cropBox.x, 1 - cropBox.x));
                  const nh = Math.max(0.1, Math.min(ry - cropBox.y, 1 - cropBox.y));
                  setCropBox(b => ({ ...b, w: nw, h: nh }));
                }
              }}
              onPointerUp={() => setCropDrag(null)}
              onPointerLeave={() => setCropDrag(null)}>
              <img
                ref={cropImageRef}
                src={cropModal.src}
                alt="crop preview"
                className="w-full object-contain"
                style={{ maxHeight: '55vh', display: 'block' }}
                draggable={false}
              />
              {/* Dark overlay outside crop box */}
              <div className="absolute inset-0 pointer-events-none"
                style={{
                  background: `linear-gradient(to bottom,
                    rgba(0,0,0,0.5) ${cropBox.y * 100}%,
                    transparent ${cropBox.y * 100}%,
                    transparent ${(cropBox.y + cropBox.h) * 100}%,
                    rgba(0,0,0,0.5) ${(cropBox.y + cropBox.h) * 100}%)`,
                }}>
                <div className="absolute"
                  style={{
                    left: 0,
                    top: `${cropBox.y * 100}%`,
                    width: `${cropBox.x * 100}%`,
                    height: `${cropBox.h * 100}%`,
                    background: 'rgba(0,0,0,0.5)'
                  }} />
                <div className="absolute"
                  style={{
                    right: 0,
                    top: `${cropBox.y * 100}%`,
                    width: `${(1 - cropBox.x - cropBox.w) * 100}%`,
                    height: `${cropBox.h * 100}%`,
                    background: 'rgba(0,0,0,0.5)'
                  }} />
              </div>
              {/* Crop box border + handles */}
              <div className="absolute border-2 border-white"
                style={{
                  left: `${cropBox.x * 100}%`,
                  top: `${cropBox.y * 100}%`,
                  width: `${cropBox.w * 100}%`,
                  height: `${cropBox.h * 100}%`,
                  cursor: 'move',
                  touchAction: 'none',
                }}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  const rect = e.currentTarget.parentElement.getBoundingClientRect();
                  const rx = (e.clientX - rect.left) / rect.width;
                  const ry = (e.clientY - rect.top) / rect.height;
                  setCropDrag({ type: 'move', ox: rx - cropBox.x, oy: ry - cropBox.y });
                  e.currentTarget.setPointerCapture(e.pointerId);
                }}>
                {/* Corner handles */}
                {[['0%','0%','-4px','-4px'], ['100%','0%','-4px','auto'], ['0%','100%','auto','-4px'], ['100%','100%','auto','auto']].map(([l,t,mt,ml], i) => (
                  <div key={i} className="absolute w-4 h-4 bg-white border border-gray-400 rounded-sm"
                    style={{ left: l, top: t, marginTop: mt === 'auto' ? undefined : mt, marginLeft: ml === 'auto' ? undefined : ml, transform: 'translate(-50%, -50%)', cursor: 'se-resize', touchAction: 'none' }}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      setCropDrag({ type: 'resize' });
                      e.currentTarget.setPointerCapture(e.pointerId);
                    }} />
                ))}
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 px-4 py-3 border-t">
              <p className="text-xs text-muted-foreground">Drag box to move • drag corner to resize</p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => {
                  // Skip crop — upload original
                  const { file, docType, driverId, driverName, scope, storeId, storeName } = cropModal;
                  setCropModal(null);
                  handleUploadFile(file, docType, driverId, driverName, scope, storeId, storeName);
                }}>Skip Crop</Button>
                <Button size="sm" onClick={handleCropConfirm}
                  disabled={!!uploadingForDriver}
                  className="bg-blue-600 hover:bg-blue-700 text-white gap-1.5">
                  {uploadingForDriver ? (
                    <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  ) : '✓'} Crop & Upload
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      </div>
    </div>
  );
}
