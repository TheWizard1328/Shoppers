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
  Search, RefreshCw, Trash2, Eye, AlertTriangle, Building2, User, Lock, ChevronRight,
  RotateCcw, RotateCw, Crop } from
'lucide-react';
import { getDriverDisplayName } from '../components/utils/driverUtils';
import { appParams } from '@/lib/app-params';
import { sortUsers } from '../components/utils/sorting';
import { DocViewerModal, DocCropModal } from '@/components/documents/DocModals';

const DOC_TYPES = [
{ key: 'license', label: "Driver's License", icon: FileText },
{ key: 'background_check', label: 'Background Check', icon: ShieldCheck },
{ key: 'contract', label: 'Driver Contract', icon: Building2 }];


const REQUESTABLE_DOC_TYPES = [
{ key: 'license', label: "Driver's License" },
{ key: 'background_check', label: 'Background Check' }];


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
  const nearest = expires.reduce((a, b) => a < b ? a : b);
  const ms = nearest - now;
  if (ms <= 0) return 'expired';
  const totalMins = Math.floor(ms / 60000);
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
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
  const [cropRotation, setCropRotation] = useState(0); // 0, 90, 180, 270
  // Viewer image rotation
  const [viewerRotation, setViewerRotation] = useState(0); // 0, 90, 180, 270
  const [savingRotation, setSavingRotation] = useState(false);

  const isAdmin = currentUser?.app_roles?.includes('admin');
  const isDispatcher = currentUser?.app_roles?.includes('dispatcher');
  const isDriver = currentUser?.app_roles?.includes('driver');

  // Build driver list
  const drivers = useMemo(() => {
    const seen = new Set();
    const driverUsers = (users || []).filter((u) => {
      if (!u?.app_roles?.includes('driver')) return false;
      if (u.status !== 'active') return false;
      if (seen.has(u.id)) return false;
      seen.add(u.id);
      return true;
    });

    // Dispatchers only see drivers matching their city(ies) AND company
    if (isDispatcher && !isAdmin) {
      // Get dispatcher's own AppUser record for city/company info
      const dispatcherAppUser = (appUsers || []).find((au) => au.user_id === currentUser?.id);
      const dispatcherCityIds = new Set([
      ...(dispatcherAppUser?.city_ids || []),
      ...(dispatcherAppUser?.city_id ? [dispatcherAppUser.city_id] : []),
      ...(currentUser?.city_ids || []),
      ...(currentUser?.city_id ? [currentUser.city_id] : [])].
      filter(Boolean));
      const dispatcherCompanyId = dispatcherAppUser?.company_id || currentUser?.company_id;

      return sortUsers(driverUsers.filter((d) => {
        const dAppUser = (appUsers || []).find((au) => au.user_id === d.id);

        // Company match — skip check if dispatcher has no company set
        if (dispatcherCompanyId) {
          const dCompanyId = dAppUser?.company_id || d.company_id;
          if (dCompanyId && dCompanyId !== dispatcherCompanyId) return false;
        }

        // City match — skip check if dispatcher has no cities set
        if (dispatcherCityIds.size > 0) {
          const dCityIds = new Set([
          ...(dAppUser?.city_ids || []),
          ...(dAppUser?.city_id ? [dAppUser.city_id] : []),
          ...(d.city_ids || []),
          ...(d.city_id ? [d.city_id] : [])].
          filter(Boolean));
          // Driver with no city assigned — include them (unassigned)
          if (dCityIds.size > 0) {
            const hasOverlap = [...dCityIds].some((cid) => dispatcherCityIds.has(cid));
            if (!hasOverlap) return false;
          }
        }

        return true;
      }));
    }
    return sortUsers(driverUsers);
  }, [users, appUsers, currentUser, isAdmin, isDispatcher]);

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
    return (stores || []).filter((s) => storeIds.includes(s?.id));
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
        const myDocs = await base44.entities.DriverDocument.filter(
          { driver_id: me.id, document_scope: 'driver' }, '-uploaded_at', 100
        );
        allDocs.push(...(myDocs || []));
      }

      // Admin (including driver+admin): load ALL driver docs
      if (isAdmin) {
        const allDriverDocs = await base44.entities.DriverDocument.filter(
          { document_scope: 'driver' }, '-uploaded_at', 500
        );
        // Deduplicate against driver's own docs already loaded
        const seenIds = new Set(allDocs.map((d) => d.id));
        for (const doc of allDriverDocs || []) {
          if (!seenIds.has(doc.id)) {
            allDocs.push(doc);
            seenIds.add(doc.id);
          }
        }
      }

      // Dispatcher (not admin, not driver): store contracts + driver docs for availability display
      if (isDispatcher && !isAdmin && !isDriver) {
        const myStoreIds = me.store_ids || [];
        for (const sid of myStoreIds) {
          const contracts = await base44.entities.DriverDocument.filter(
            { store_id: sid, document_scope: 'store', document_type: 'contract' }, '-uploaded_at', 10
          );
          allDocs.push(...(contracts || []));
        }
        // Load all driver-scoped docs so dispatcher can see what's available per driver
        const driverDocs = await base44.entities.DriverDocument.filter(
          { document_scope: 'driver' }, '-uploaded_at', 500
        );
        const seenIds = new Set(allDocs.map((d) => d.id));
        for (const doc of driverDocs || []) {
          if (!seenIds.has(doc.id)) {
            allDocs.push(doc);
            seenIds.add(doc.id);
          }
        }
      }

      setDocuments(allDocs);

      // Load access requests
      let requests = [];
      if (isAdmin) {
        requests = await base44.entities.DocAccessRequest.list('-requested_at', 200);
      } else if (isDispatcher) {
        requests = await base44.entities.DocAccessRequest.filter(
          { requester_id: me.id }, '-requested_at', 100
        );
      } else if (isDriver) {
        requests = await base44.entities.DocAccessRequest.filter(
          { driver_id: me.id }, '-requested_at', 100
        );
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
    const unsubDoc = base44.entities.DriverDocument.subscribe(() => loadData(true));
    const unsubReq = base44.entities.DocAccessRequest.subscribe(() => loadData(true));
    return () => {unsubDoc();unsubReq();};
  }, [loadData]);

  // Get documents for a specific driver
  const getDriverDocs = useCallback((driverId) => {
    return documents.filter((d) => d.driver_id === driverId && d.document_scope === 'driver');
  }, [documents]);

  // Get store contracts
  const getStoreContracts = useCallback((storeId) => {
    return documents.filter((d) => d.store_id === storeId && d.document_scope === 'store' && d.document_type === 'contract');
  }, [documents]);

  // Toggle driver selection
  const toggleDriver = (driverId) => {
    setSelectedDriverIds((prev) => {
      const next = new Set(prev);
      if (next.has(driverId)) next.delete(driverId);else
      next.add(driverId);
      return next;
    });
  };

  // Toggle doc type selection
  const toggleDocType = (docKey) => {
    setSelectedDocTypes((prev) => {
      const next = new Set(prev);
      if (next.has(docKey)) next.delete(docKey);else
      next.add(docKey);
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
      const driverNames = driverIds.map((id) => {
        const d = drivers.find((dr) => dr.id === id);
        return getDriverDisplayName(d) || id;
      });

      await base44.functions.invoke('docAccessManager', {
        action: 'createRequest',
        driver_ids: driverIds,
        driver_names: driverNames,
        requested_doc_types: docTypes
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
        request_id: requestId
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
        request_id: requestId
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
    setViewerRotation(0);
    try {
      const me = await base44.auth.me();
      const resp = await base44.functions.invoke('serveDriverDoc', {
        doc_id: doc.id,
        viewer_id: me.id,
        viewer_name: me.full_name || me.email || 'Unknown'
      });

      // Set first_viewed_at for access requests
      if (!isAdmin) {
        const activeReq = accessRequests.find((r) =>
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
    if (file.size > 15 * 1024 * 1024) {alert('File too large. Maximum 15MB.');return;}
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    if (!allowedTypes.includes(file.type)) {alert('Invalid file type. Use JPG, PNG, WebP, or PDF.');return;}

    if (file.type === 'application/pdf') {
      // PDFs go straight to upload — no crop
      handleUploadFile(file, docType, driverId, driverName, scope, storeId, storeName);
      return;
    }

    // Images: show crop modal
    const reader = new FileReader();
    reader.onload = (ev) => {
      setCropBox({ x: 0.05, y: 0.05, w: 0.9, h: 0.9 });
      setCropRotation(0);
      setCropModal({ src: ev.target.result, file, docType, driverId, driverName, scope, storeId, storeName });
    };
    reader.readAsDataURL(file);
  };

  // Upload document after optional crop — sends base64 via base44.functions.invoke
  // Pass existingDocId to replace an existing record rather than create a new one
  const handleUploadFile = async (file, docType, driverId, driverName, scope = 'driver', storeId = null, storeName = null, existingDocId = null) => {
    if (!file) return;
    setUploadingForDriver(docType + (driverId || storeId || ''));
    try {
      // Encode file as base64 data URL — then the backend handles the actual storage upload
      const base64DataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      const result = await base44.functions.invoke('docAccessManager', {
        action: 'uploadDocumentBase64',
        document_type: docType,
        document_scope: scope,
        driver_id: driverId || null,
        driver_name: driverName || null,
        store_id: storeId || null,
        store_name: storeName || null,
        file_data_url: base64DataUrl,
        file_name: file.name || `doc_${Date.now()}.jpg`,
        file_size: file.size,
        mime_type: file.type || 'image/jpeg',
        existing_doc_id: existingDocId || null,
      });

      const resultData = result?.data || result;
      if (!resultData?.success) throw new Error(resultData?.error || 'Upload failed');
      await loadData(true);
    } catch (err) {
      console.error('Upload failed:', err);
      alert('Upload failed: ' + (err.message || 'Unknown error'));
    } finally {
      setUploadingForDriver(null);
    }
  };

  // Confirm crop: draw cropped region to canvas (with rotation) and upload as blob
  const handleCropConfirm = async () => {
    if (!cropModal || !cropImageRef.current) return;
    const img = cropImageRef.current;
    const { x, y, w, h } = cropBox;

    // First render the full image rotated onto an intermediate canvas
    const rad = (cropRotation * Math.PI) / 180;
    const isOdd = cropRotation === 90 || cropRotation === 270;
    const rotW = isOdd ? img.naturalHeight : img.naturalWidth;
    const rotH = isOdd ? img.naturalWidth : img.naturalHeight;
    const rotCanvas = document.createElement('canvas');
    rotCanvas.width = rotW;
    rotCanvas.height = rotH;
    const rotCtx = rotCanvas.getContext('2d');
    rotCtx.translate(rotW / 2, rotH / 2);
    rotCtx.rotate(rad);
    rotCtx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);

    // Now crop from the rotated canvas
    const sx = rotW * x;
    const sy = rotH * y;
    const sw = rotW * w;
    const sh = rotH * h;

    const MAX_SIDE = 1600;
    const scale = Math.min(1, MAX_SIDE / Math.max(sw, sh));
    const dw = Math.round(sw * scale);
    const dh = Math.round(sh * scale);

    const canvas = document.createElement('canvas');
    canvas.width = dw;
    canvas.height = dh;
    canvas.getContext('2d').drawImage(rotCanvas, sx, sy, sw, sh, 0, 0, dw, dh);

    canvas.toBlob(async (blob) => {
      if (!blob) {alert('Failed to process image.');return;}
      const croppedFile = new File([blob], `doc_${Date.now()}.jpg`, { type: 'image/jpeg' });
      const { docType, driverId, driverName, scope, storeId, storeName, existingDocId } = cropModal;
      setCropModal(null);
      await handleUploadFile(croppedFile, docType, driverId, driverName, scope, storeId, storeName, existingDocId || null);
    }, 'image/jpeg', 0.85);
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

  // Revoke access (deny an approved request)
  const handleRevokeAccess = async (requestId) => {
    setActionLoading('revoke-' + requestId);
    try {
      await base44.functions.invoke('docAccessManager', {
        action: 'revoke',
        request_id: requestId
      });
      await loadData(true);
    } catch (err) {
      console.error('Revoke failed:', err);
      alert('Failed to revoke access: ' + (err.message || ''));
    } finally {
      setActionLoading(null);
    }
  };

  // Delete a document
  const handleDeleteDoc = async (docId) => {
    if (!confirm('Delete this document? This cannot be undone.')) return;
    setActionLoading('delete-' + docId);
    try {
      await base44.functions.invoke('docAccessManager', {
        action: 'deleteDocument',
        doc_id: docId
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

  // Save the current viewer rotation back to storage as a new upload (replaces the doc)
  const handleSaveRotation = async () => {
    if (!viewingDoc || !docUrl || viewerRotation === 0) return;
    setSavingRotation(true);
    try {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = docUrl; });
      const rad = (viewerRotation * Math.PI) / 180;
      const isOdd = viewerRotation === 90 || viewerRotation === 270;
      const rw = isOdd ? img.naturalHeight : img.naturalWidth;
      const rh = isOdd ? img.naturalWidth : img.naturalHeight;
      const canvas = document.createElement('canvas');
      canvas.width = rw; canvas.height = rh;
      const ctx = canvas.getContext('2d');
      ctx.translate(rw / 2, rh / 2);
      ctx.rotate(rad);
      ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
      const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.9));
      const file = new File([blob], `doc_${Date.now()}.jpg`, { type: 'image/jpeg' });
      await handleUploadFile(file, viewingDoc.document_type, viewingDoc.driver_id, viewingDoc.driver_name, viewingDoc.document_scope, viewingDoc.store_id, viewingDoc.store_name, viewingDoc.id);
      setViewerRotation(0);
      // Reload the doc URL after save
      const resp = await base44.functions.invoke('serveDriverDoc', { doc_id: viewingDoc.id, viewer_id: (await base44.auth.me()).id, viewer_name: '' });
      const data = resp?.data || resp;
      setDocUrl(data?.file_url || null);
    } catch (err) {
      alert('Failed to save rotation: ' + (err.message || ''));
    } finally {
      setSavingRotation(false);
    }
  };

  // Open the crop modal from the currently viewed image URL (re-crop existing doc)
  const handleRecropFromViewer = async () => {
    if (!viewingDoc || !docUrl) return;
    setSavingRotation(true); // reuse spinner state to disable buttons
    try {
      const resp = await fetch(docUrl);
      const blob = await resp.blob();
      const file = new File([blob], `doc_${Date.now()}.jpg`, { type: blob.type || 'image/jpeg' });
      const reader = new FileReader();
      reader.onload = (ev) => {
        setCropBox({ x: 0.05, y: 0.05, w: 0.9, h: 0.9 });
        setCropRotation(viewerRotation);
        setCropModal({
          src: ev.target.result, file,
          docType: viewingDoc.document_type,
          driverId: viewingDoc.driver_id,
          driverName: viewingDoc.driver_name,
          scope: viewingDoc.document_scope,
          storeId: viewingDoc.store_id,
          storeName: viewingDoc.store_name,
          existingDocId: viewingDoc.id,
        });
        setViewingDoc(null);
        setDocUrl(null);
        setViewerRotation(0);
      };
      reader.readAsDataURL(file);
    } catch (err) {
      alert('Failed to load image for re-crop: ' + (err.message || ''));
    } finally {
      setSavingRotation(false);
    }
  };

  // Get driver's pending incoming requests (for driver view)
  const myPendingRequests = useMemo(() => {
    if (!isDriver) return [];
    return accessRequests.filter((r) => r.status === 'pending' && r.driver_id === currentUser?.id);
  }, [accessRequests, isDriver, isAdmin, currentUser]);

  // Get dispatcher's active approved requests
  const myActiveAccess = useMemo(() => {
    if (!isDispatcher) return [];
    return accessRequests.filter((r) => isAccessActive(r));
  }, [accessRequests, isDispatcher, isAdmin]);

  // Pending requests for admin to review
  const allPendingRequests = useMemo(() => {
    if (!isAdmin) return [];
    return accessRequests.filter((r) => r.status === 'pending');
  }, [accessRequests, isAdmin]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="w-8 h-8 border-2 border-slate-200 border-t-slate-800 rounded-full animate-spin" />
      </div>);

  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header — fixed */}
      <div className="flex-shrink-0 px-4 sm:px-6 pt-4 pb-3 max-w-7xl w-full mx-auto">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-2">
            <Shield className="w-6 h-6 text-blue-600" />
            <h1 className="text-xl font-bold">Documents</h1>
            <Badge className="ml-2 bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-200 border-0">
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
      {isDriver &&
        <div className="space-y-4">
          {/* Incoming access requests (driver approves/denies) — hidden for admins since they see the full admin panel */}
          {myPendingRequests.length > 0 && !isAdmin &&
          <Card className="border-amber-200 bg-amber-50">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Clock className="w-4 h-4 text-amber-600" />
                  Access Requests ({myPendingRequests.length})
                </CardTitle>
                <CardDescription>Dispatchers are requesting to view your documents</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {myPendingRequests.map((req) =>
              <div key={req.id} className="flex items-center justify-between gap-3 p-3 bg-card rounded-lg border">
                    <div className="min-w-0">
                      <p className="font-medium text-sm">{req.requester_name || 'Dispatcher'}</p>
                      <p className="text-xs text-muted-foreground">
                        wants to view: {(req.requested_doc_types || []).map((t) => t.replace(/_/g, ' ')).join(', ')}
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
              )}
              </CardContent>
            </Card>
          }

          {/* My uploaded files — view/re-crop/rotate */}
          {documents.filter((d) => d.driver_id === currentUser?.id && d.document_scope === 'driver').length > 0 &&
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">My Uploaded Documents</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-1">
                {documents.filter((d) => d.driver_id === currentUser?.id && d.document_scope === 'driver').map((doc) =>
                <div key={doc.id} className="p-3 border rounded-lg text-sm">
                    <div className="flex items-center gap-2">
                      <div className="flex items-center gap-1.5 flex-1 min-w-0">
                        <span className="font-semibold capitalize">{doc.document_type?.replace(/_/g, ' ')}</span>
                        <span className="text-muted-foreground text-xs">{formatDateTime(doc.uploaded_at)}</span>
                      </div>
                      <span
                        onClick={() => handleViewDoc(doc)}
                        className="cursor-pointer text-xs font-medium px-2.5 py-1 rounded-full bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 hover:bg-blue-200 dark:hover:bg-blue-900/60 transition-colors flex-shrink-0">
                        View
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
          }

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
                const existingDoc = documents.find((d) => d.document_type === key && d.driver_id === currentUser?.id);
                return (
                  <div key={key} className="p-3 border rounded-lg">
                   <input id={`file-input-${key}`} type="file" className="hidden"
                    accept="image/jpeg,image/png,image/webp,application/pdf"
                    onChange={(e) => handleDriverFileInput(e, key)} />
                   <input id={`camera-input-${key}`} type="file" className="hidden"
                    accept="image/*" capture="environment"
                    onChange={(e) => handleDriverFileInput(e, key)} />
                   {/* Single row on all screen sizes */}
                   <div className="flex items-center gap-2">
                     {/* Left: icon + label */}
                     <div className="flex items-center gap-2 flex-1 min-w-0">
                       <div className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 ${existingDoc ? 'bg-emerald-100 dark:bg-emerald-900/40' : 'bg-muted'}`}>
                         {existingDoc ? <CheckCircle className="w-3.5 h-3.5 text-emerald-600" /> : <FileText className="w-3.5 h-3.5 text-muted-foreground" />}
                       </div>
                       <p className="font-semibold text-sm truncate">{label}</p>
                     </div>
                     {/* Right: date (desktop only) + action badge */}
                     <div className="flex items-center gap-2 flex-shrink-0">
                       <p className="text-xs text-muted-foreground hidden sm:block">
                         {existingDoc ?
                          <>Uploaded {formatDateTime(existingDoc.uploaded_at)}{existingDoc.document_expiry_date && ` • expires ${existingDoc.document_expiry_date}`}</> :
                          'Not uploaded'}
                       </p>
                       <span
                          onClick={() => !uploadingForDriver && document.getElementById(`file-input-${key}`)?.click()}
                          className="cursor-pointer text-xs font-medium px-2.5 py-1 rounded-full bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors flex-shrink-0">
                         {existingDoc ? 'Replace' : 'Upload'}
                       </span>
                     </div>
                   </div>
                  </div>);

              })}
              {uploadingForDriver &&
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <div className="w-4 h-4 border-2 border-slate-200 border-t-slate-800 rounded-full animate-spin" />
                  Uploading...
                </div>
              }
            </CardContent>
          </Card>
        </div>
        }

      {/* === ADMIN SECTION (not dispatcher-only) === */}
      {isAdmin &&
        <div className="space-y-4">
          {/* Pending requests for admin to approve */}
          {allPendingRequests.length > 0 &&
          <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Clock className="w-4 h-4 text-amber-600" />
                  Access Requests to Review ({allPendingRequests.length})
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {allPendingRequests.map((req) =>
              <div key={req.id} className="flex items-center justify-between gap-3 p-3 border rounded-lg bg-amber-50/50">
                    <div className="min-w-0">
                      <p className="font-medium text-sm">
                        {req.requester_name} → {req.driver_name}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {(req.requested_doc_types || []).map((t) => t.replace(/_/g, ' ')).join(', ')} • {formatDateTime(req.requested_at)}
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
              )}
              </CardContent>
            </Card>
          }

          {/* All documents table */}
          {!viewingDoc &&
          <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">All Documents</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-1">
                  {documents.filter((d) => d.document_scope === 'driver').map((doc) => {
                  const docAccessList = accessRequests.filter((r) =>
                  r.driver_id === doc.driver_id &&
                  (r.requested_doc_types || []).includes(doc.document_type) && (
                  r.status === 'pending' || isAccessActive(r))
                  );
                  return (
                    <div key={doc.id} className="p-3 border rounded-lg text-sm">
                        {/* Single row on all screen sizes */}
                        <div className="flex items-center gap-2">
                          {/* Left: driver name + doc type */}
                          <div className="flex items-center gap-1.5 flex-1 min-w-0">
                            <span className="font-semibold">{doc.driver_name || 'Unknown'}</span>
                            <span className="text-muted-foreground text-xs capitalize">{doc.document_type?.replace(/_/g, ' ')}</span>
                          </div>
                          {/* Right: date (desktop only) + View + Delete */}
                          <div className="flex items-center gap-2 flex-shrink-0">
                            <span className="text-xs text-muted-foreground hidden sm:inline">{formatDateTime(doc.uploaded_at)}</span>
                            <span
                            onClick={() => handleViewDoc(doc)}
                            className="cursor-pointer text-xs font-medium px-2.5 py-1 rounded-full bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 hover:bg-blue-200 dark:hover:bg-blue-900/60 transition-colors flex-shrink-0">
                              View
                            </span>
                            <span
                            onClick={() => !actionLoading && handleDeleteDoc(doc.id)}
                            className="cursor-pointer text-xs font-medium px-2.5 py-1 rounded-full bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300 hover:bg-red-200 dark:hover:bg-red-900/60 transition-colors flex-shrink-0">
                              Delete
                            </span>
                          </div>
                        </div>
                        {docAccessList.map((req) => {
                        const active = isAccessActive(req);
                        const remaining = active ? getTimeRemaining(req) : null;
                        return (
                          <div key={req.id} className={`flex items-center justify-between gap-2 px-2 py-1.5 rounded text-xs ${active ? 'bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800' : 'bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800'}`}>
                              <div className="min-w-0 flex-1">
                                <span className={`font-semibold ${active ? 'text-emerald-800 dark:text-emerald-300' : 'text-amber-800 dark:text-amber-300'}`}>{req.requester_name}</span>
                                <span className="text-muted-foreground ml-1">{active ? '— Active access' : '— Pending'}</span>
                                {req.first_viewed_at &&
                              <span className="text-muted-foreground ml-1">• Viewed {formatDateTime(req.first_viewed_at)}</span>
                              }
                              </div>
                              <div className="flex items-center gap-1.5 flex-shrink-0">
                                {remaining &&
                              <Badge variant="outline" className="text-xs gap-1 border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-300 h-5">
                                    <Clock className="w-2.5 h-2.5" /> {remaining}
                                  </Badge>
                              }
                                {active &&
                              <Button size="sm" variant="ghost" className="h-5 text-red-600 hover:text-red-700 px-1.5 text-xs"
                              disabled={actionLoading === 'revoke-' + req.id}
                              onClick={() => handleRevokeAccess(req.id)}>
                                    <XCircle className="w-3 h-3 mr-0.5" /> Revoke
                                  </Button>
                              }
                              </div>
                            </div>);

                      })}
                      </div>);

                })}
                  {documents.filter((d) => d.document_scope === 'driver').length === 0 &&
                <p className="text-center text-sm text-muted-foreground py-4">No documents uploaded yet</p>
                }
                </div>
              </CardContent>
            </Card>
          }
        </div>
        }

      {/* === DISPATCHER SECTION (dispatchers only, not admins) === */}
      {isDispatcher && !isAdmin &&
        <div className="space-y-4">
          {/* Active approved access */}
          {myActiveAccess.length > 0 &&
          <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4 text-emerald-600" />
                  Active Access ({myActiveAccess.length})
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {myActiveAccess.map((req) =>
              <div key={req.id} className="flex items-center justify-between gap-3 p-3 border rounded-lg bg-emerald-50/50">
                    <div className="min-w-0">
                      <p className="font-medium text-sm flex items-center gap-2">
                        {req.driver_name}
                        <Badge className="bg-emerald-100 text-emerald-800 text-xs">Approved</Badge>
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {(req.requested_doc_types || []).map((t) => t.replace(/_/g, ' ')).join(', ')}
                        {req.first_viewed_at && ' • viewed ' + formatDateTime(req.first_viewed_at)}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {getTimeRemaining(req) &&
                  <Badge variant="outline" className="text-xs gap-1">
                          <Clock className="w-3 h-3" /> {getTimeRemaining(req)}
                        </Badge>
                  }
                      <Button size="sm" variant="outline" onClick={() => {
                    const driverDocs = getDriverDocs(req.driver_id).filter((d) =>
                    (req.requested_doc_types || []).includes(d.document_type)
                    );
                    if (driverDocs.length > 0) handleViewDoc(driverDocs[0]);
                  }} className="h-8 gap-1.5">
                        <Eye className="w-3.5 h-3.5" /> View
                      </Button>
                    </div>
                  </div>
              )}
              </CardContent>
            </Card>
          }

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
                {REQUESTABLE_DOC_TYPES.map(({ key, label }) =>
                <label key={key} className="flex items-center gap-2 cursor-pointer">
                    <Checkbox checked={selectedDocTypes.has(key)} onCheckedChange={() => toggleDocType(key)} />
                    <span className="text-sm">{label}</span>
                  </label>
                )}
                <label className="flex items-center gap-2 cursor-pointer">
                  <Checkbox checked={includeContract} onCheckedChange={() => setIncludeContract(!includeContract)} />
                  <span className="text-sm">Include Contract (no approval needed)</span>
                </label>
              </div>

              {/* Driver list */}
              <div className="max-h-60 overflow-y-auto space-y-1 border rounded-lg p-2">
                {filteredDrivers.length === 0 ?
                <p className="text-center text-sm text-muted-foreground py-4">No drivers found</p> :

                filteredDrivers.map((driver) => {
                  const isSelected = selectedDriverIds.has(driver.id);
                  const driverDocs = getDriverDocs(driver.id);
                  const hasLicense = driverDocs.some((d) => d.document_type === 'license');
                  const hasBg = driverDocs.some((d) => d.document_type === 'background_check');
                  const now = new Date();
                  const driverRequests = accessRequests.filter((r) => r.driver_id === driver.id);
                  const hasPending = driverRequests.some((r) => r.status === 'pending');
                  const hasReadyToView = driverRequests.some((r) =>
                  r.status === 'approved' &&
                  !r.first_viewed_at && (
                  !r.expires_at || now < new Date(r.expires_at))
                  );
                  return (
                    <div key={driver.id}
                    className={`flex items-center gap-3 p-2 rounded-lg cursor-pointer transition-colors ${
                    isSelected ? 'bg-blue-50 border border-blue-200' : 'hover:bg-muted'}`
                    }
                    onClick={() => toggleDriver(driver.id)}>
                        <Checkbox checked={isSelected} onCheckedChange={() => {}} />
                        <div className="flex-1 min-w-0 flex items-center gap-2">
                          <p className="text-sm font-medium flex-1 min-w-0 truncate">{getDriverDisplayName(driver)}</p>
                          <span className={`text-xs px-2 py-0.5 rounded font-medium w-20 text-center flex-shrink-0 ${hasLicense ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-400'}`}>
                            {hasLicense ? '✓ License' : '✗ License'}
                          </span>
                          <span className={`text-xs px-2 py-0.5 rounded font-medium text-center flex-shrink-0 w-40 ${hasBg ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-400'}`}>
                            {hasBg ? '✓ Background Check' : '✗ Background Check'}
                          </span>
                        </div>
                        {(hasPending || hasReadyToView) &&
                      <div className="flex-shrink-0 flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-semibold"
                      style={hasPending ?
                      { background: '#fee2e2', color: '#991b1b' } :
                      { background: '#dcfce7', color: '#166534' }}>
                            {hasPending ? '⏳ Pending' : '✓ Ready'}
                          </div>
                      }
                      </div>);

                })
                }
              </div>

              {/* Request button */}
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm text-muted-foreground">
                  {selectedDriverIds.size > 0 ? `${selectedDriverIds.size} driver(s) selected` : 'Select drivers above'}
                </span>
                <Button onClick={submitRequest} disabled={submitting || selectedDriverIds.size === 0 || selectedDocTypes.size === 0}
                className="gap-2">
                  {submitting ?
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> :

                  <Shield className="w-4 h-4" />
                  }
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
              {dispatcherStores.map((store) => {
                const contracts = getStoreContracts(store.id);
                return (
                  <div key={store.id} className="flex items-center gap-3 p-3 border rounded-lg">
                    <input ref={contractFileRef} type="file" className="hidden"
                    accept="image/jpeg,image/png,image/webp,application/pdf"
                    onChange={(e) => handleContractFileInput(e, store.id, store?.name)} />
                    <input ref={contractCameraRef} type="file" className="hidden"
                    accept="image/*" capture="environment"
                    onChange={(e) => handleContractFileInput(e, store.id, store?.name)} />
                    <p className="text-sm font-medium flex-1 min-w-0 truncate">{store?.name || 'Unknown Store'}</p>
                    {contracts.length === 0 ?
                    <span className="text-xs text-muted-foreground flex-shrink-0">No contract uploaded</span> :
                    contracts.map((c) =>
                    <span key={c.id} className="text-xs text-muted-foreground flex-shrink-0">
                        {formatDateTime(c.uploaded_at)}
                        {c.document_expiry_date && ` • expires ${c.document_expiry_date}`}
                      </span>
                    )}
                    {contracts.map((c) =>
                    <div key={c.id} className="flex items-center gap-1 flex-shrink-0">
                        <Button size="sm" variant="ghost" className="h-8" onClick={() => handleViewDoc(c)}>
                          <Eye className="w-3.5 h-3.5" /> View
                        </Button>
                        <Button size="sm" variant="ghost" className="h-8 text-red-600"
                      onClick={() => handleDeleteDoc(c.id)} disabled={actionLoading === 'delete-' + c.id}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    )}
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <Button size="sm" variant="outline" className="h-8 gap-1.5"
                      disabled={uploadingContract}
                      onClick={() => contractFileRef.current?.click()}>
                        <Upload className="w-3.5 h-3.5" /> Upload
                      </Button>
                      {!isMobile &&
                      <Button size="sm" variant="ghost" className="h-8"
                      disabled={uploadingContract}
                      onClick={() => contractCameraRef.current?.click()}>
                          <Camera className="w-3.5 h-3.5" />
                        </Button>
                      }
                    </div>
                  </div>);

              })}
              {uploadingContract &&
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <div className="w-4 h-4 border-2 border-slate-200 border-t-slate-800 rounded-full animate-spin" />
                  Uploading contract...
                </div>
              }
            </CardContent>
          </Card>
        </div>
        }

      <DocViewerModal
        isMobile={isMobile}
        viewingDoc={viewingDoc}
        docUrl={docUrl}
        docLoading={docLoading}
        viewerRotation={viewerRotation}
        setViewerRotation={setViewerRotation}
        savingRotation={savingRotation}
        onClose={() => { setViewingDoc(null); setDocUrl(null); }}
        onSaveRotation={handleSaveRotation}
        onRecrop={handleRecropFromViewer}
      />

      <DocCropModal
        cropModal={cropModal}
        cropImageRef={cropImageRef}
        cropBox={cropBox}
        setCropBox={setCropBox}
        cropRotation={cropRotation}
        setCropRotation={setCropRotation}
        cropDrag={cropDrag}
        setCropDrag={setCropDrag}
        uploadingForDriver={uploadingForDriver}
        onClose={() => setCropModal(null)}
        onConfirm={handleCropConfirm}
        onSkip={async () => {
          const { file, docType, driverId, driverName, scope, storeId, storeName, existingDocId } = cropModal;
          const rot = cropRotation;
          setCropModal(null);
          const img2 = new Image();
          img2.onload = () => {
            const isOdd2 = rot === 90 || rot === 270;
            const rw = isOdd2 ? img2.naturalHeight : img2.naturalWidth;
            const rh = isOdd2 ? img2.naturalWidth : img2.naturalHeight;
            const MAX = 1600;
            const scale2 = Math.min(1, MAX / Math.max(rw, rh));
            const c2 = document.createElement('canvas');
            c2.width = Math.round(rw * scale2);
            c2.height = Math.round(rh * scale2);
            const ctx2 = c2.getContext('2d');
            ctx2.translate(c2.width / 2, c2.height / 2);
            ctx2.rotate((rot * Math.PI) / 180);
            ctx2.drawImage(img2, -img2.naturalWidth * scale2 / 2, -img2.naturalHeight * scale2 / 2, img2.naturalWidth * scale2, img2.naturalHeight * scale2);
            c2.toBlob(async (b) => {
              const f2 = new File([b || file], `doc_${Date.now()}.jpg`, { type: 'image/jpeg' });
              await handleUploadFile(f2, docType, driverId, driverName, scope, storeId, storeName, existingDocId || null);
            }, 'image/jpeg', 0.85);
          };
          img2.src = URL.createObjectURL(file);
        }}
      />

      </div>
    </div>);

}