import { useState, useEffect, useCallback, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  FileText, ShieldCheck, Lock, ScrollText, Printer, Upload,
  CheckCircle, AlertCircle, RefreshCw, Building2, Eye
} from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { isAppOwner } from '@/components/utils/userRoles';

const DOC_META = {
  legal_cover_sheet: {
    label: 'Legal Review Cover Sheet',
    description: 'Internal legal review document',
    icon: ScrollText,
    requiresSignature: false,
    appOwnerOnly: true,
  },
  PIA: {
    label: 'PIA Vendor Package',
    description: 'Privacy Impact Assessment — reference document (not signed)',
    icon: ShieldCheck,
    requiresSignature: false,
    appOwnerOnly: false,
  },
  IMA: {
    label: 'Information Manager Agreement (IMA)',
    description: 'HIA Section 66 contract — must be signed by each pharmacy licensee',
    icon: FileText,
    requiresSignature: true,
    appOwnerOnly: false,
  },
  NDA: {
    label: 'Non-Disclosure Agreement (NDA)',
    description: 'Confidentiality agreement — must be signed by each pharmacy location',
    icon: Lock,
    requiresSignature: true,
    appOwnerOnly: false,
  },
};

export default function ComplianceDocsSection({ currentUser, stores }) {
  const [templates, setTemplates] = useState([]);
  const [signedDocs, setSignedDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploadingFor, setUploadingFor] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const fileInputRef = useRef(null);
  const [pendingUpload, setPendingUpload] = useState(null);

  const canAccess = isAppOwner(currentUser) || currentUser?.app_roles?.includes('store_owner') || currentUser?.is_store_owner === true;
  const isOwner = isAppOwner(currentUser);

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      console.log('[ComplianceDocs] Loading templates and signed docs...');
      const [templatesRes, signedRes] = await Promise.all([
        base44.entities.ComplianceDocument.filter({ status: 'template' }).catch((e) => {
          console.error('[ComplianceDocs] Template fetch failed:', e);
          return [];
        }),
        base44.entities.ComplianceDocument.filter({ status: 'signed' }).catch((e) => {
          console.error('[ComplianceDocs] Signed fetch failed:', e);
          return [];
        }),
      ]);
      console.log('[ComplianceDocs] Loaded', templatesRes?.length || 0, 'templates,', signedRes?.length || 0, 'signed docs');
      setTemplates(templatesRes || []);
      setSignedDocs(signedRes || []);
    } catch (err) {
      console.error('[ComplianceDocs] Failed to load:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (canAccess) loadData();
  }, [canAccess, loadData]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadData();
    setRefreshing(false);
  }, [loadData]);

  const visibleTemplates = templates.filter((t) => {
    const meta = DOC_META[t.document_type];
    if (!meta) return false;
    if (meta.appOwnerOnly && !isOwner) return false;
    return true;
  });

  const mySignedDocs = isOwner
    ? signedDocs
    : signedDocs.filter((d) => d.store_owner_id === currentUser?.id);

  const needsSigning = (docType) => {
    if (!DOC_META[docType]?.requiresSignature) return false;
    return !mySignedDocs.some((d) => d.document_type === docType);
  };

  const needsResign = (docType) => {
    if (!DOC_META[docType]?.requiresSignature) return false;
    const template = templates.find((t) => t.document_type === docType);
    if (!template) return false;
    const signed = mySignedDocs.find((d) => d.document_type === docType);
    if (!signed) return false;
    return signed.signed_from_version !== template.version;
  };

  const handlePrint = (doc) => {
    if (doc.file_url) window.open(doc.file_url, '_blank');
  };

  const handleUploadSigned = (docType, docTitle, version) => {
    setPendingUpload({ docType, docTitle, version });
    fileInputRef.current?.click();
  };

  const handleFileSelected = async (event) => {
    const file = event.target.files?.[0];
    if (!file || !pendingUpload) return;

    if (file.size > 20 * 1024 * 1024) {
      alert('File too large. Maximum 20MB.');
      event.target.value = '';
      return;
    }

    const allowedTypes = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
    if (!allowedTypes.includes(file.type)) {
      alert('Invalid file type. Please upload a PDF, JPG, PNG, or WebP of the signed document.');
      event.target.value = '';
      return;
    }

    setUploadingFor(pendingUpload.docType);
    event.target.value = '';

    try {
      const { file_url } = await base44.integrations.Core.UploadFile({ file });
      const fileUrl = file_url;

      const storeOwnerName = currentUser?.user_name || currentUser?.full_name || 'Unknown';
      const coveredStoreIds = currentUser?.store_ids || [];

      await base44.entities.ComplianceDocument.create({
        document_type: pendingUpload.docType,
        title: DOC_META[pendingUpload.docType].label + ' — Signed (' + storeOwnerName + ')',
        status: 'signed',
        file_url: fileUrl,
        mime_type: file.type,
        version: pendingUpload.version,
        store_owner_id: currentUser?.id,
        store_owner_name: storeOwnerName,
        covered_store_ids: coveredStoreIds,
        signed_by_name: storeOwnerName,
        signed_by_user_id: currentUser?.id,
        signed_at: new Date().toISOString(),
        signed_from_version: pendingUpload.version,
        uploaded_at: new Date().toISOString(),
        uploaded_by: currentUser?.id,
        uploaded_by_name: storeOwnerName,
      });

      await loadData();
    } catch (err) {
      console.error('[ComplianceDocs] Upload failed:', err);
      alert('Failed to upload signed document: ' + (err.message || ''));
    } finally {
      setUploadingFor(null);
      setPendingUpload(null);
    }
  };

  console.log('[ComplianceDocs] canAccess:', canAccess, 'isOwner:', isOwner, 'currentUser role:', currentUser?.role, 'app_roles:', currentUser?.app_roles);
  if (!canAccess) return null;

  if (loading) {
    return (
      <Card>
        <CardContent className="py-6">
          <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <RefreshCw className="w-4 h-4 animate-spin" />
            Loading compliance documents...
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-blue-200 dark:border-blue-900/50">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-blue-600" />
              Compliance &amp; Legal Documents
            </CardTitle>
            <CardDescription>
              {isOwner
                ? 'Manage templates and view all signed compliance documents'
                : 'View, print, and upload signed compliance documents'}
            </CardDescription>
          </div>
          <Button variant="ghost" size="sm" onClick={handleRefresh} disabled={refreshing} className="text-xs">
            <RefreshCw className={'w-3.5 h-3.5 ' + (refreshing ? 'animate-spin' : '')} />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={handleFileSelected}
        />

        {/* === TEMPLATES === */}
        <div>
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
            {isOwner ? 'Document Templates' : 'Available Documents'}
          </h4>
          <div className="space-y-2">
            {visibleTemplates.length === 0 && (
              <p className="text-sm text-muted-foreground italic py-2">No templates available.</p>
            )}
            {visibleTemplates.map((doc) => {
              const meta = DOC_META[doc.document_type];
              if (!meta) return null;
              const Icon = meta.icon;
              const needsSign = needsSigning(doc.document_type);
              const needsReSign = needsResign(doc.document_type);
              const hasSigned = !needsSign && meta.requiresSignature;

              return (
                <div
                  key={doc.id}
                  className={'flex items-start gap-3 p-3 border rounded-lg text-sm ' + (needsReSign ? 'border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-900' : '')}
                >
                  <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 bg-blue-100 dark:bg-blue-900/40">
                    <Icon className="w-4 h-4 text-blue-600 dark:text-blue-300" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-semibold truncate">{meta.label}</p>
                      {doc.version && (
                        <Badge variant="outline" className="text-xs px-1.5 py-0 h-5">{doc.version}</Badge>
                      )}
                      {meta.requiresSignature && (
                        <Badge className="text-xs px-1.5 py-0 h-5 bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                          Requires Signature
                        </Badge>
                      )}
                      {hasSigned && (
                        <Badge className="text-xs px-1.5 py-0 h-5 bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">
                          <CheckCircle className="w-3 h-3 mr-0.5" /> Signed
                        </Badge>
                      )}
                      {needsReSign && (
                        <Badge className="text-xs px-1.5 py-0 h-5 bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300">
                          <AlertCircle className="w-3 h-3 mr-0.5" /> Re-sign needed
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">{meta.description}</p>

                    <div className="flex gap-2 mt-2 flex-wrap">
                      <Button variant="outline" size="sm" className="text-xs h-7 px-2" onClick={() => handlePrint(doc)}>
                        <Eye className="w-3 h-3 mr-1" /> View
                      </Button>
                      <Button variant="outline" size="sm" className="text-xs h-7 px-2" onClick={() => handlePrint(doc)}>
                        <Printer className="w-3 h-3 mr-1" /> Print
                      </Button>
                      {meta.requiresSignature && !isOwner && (
                        <Button
                          variant={needsSign || needsReSign ? 'default' : 'outline'}
                          size="sm"
                          className="text-xs h-7 px-2"
                          onClick={() => handleUploadSigned(doc.document_type, doc.title, doc.version)}
                          disabled={uploadingFor === doc.document_type}
                        >
                          {uploadingFor === doc.document_type ? (
                            <><RefreshCw className="w-3 h-3 mr-1 animate-spin" /> Uploading...</>
                          ) : (
                            <><Upload className="w-3 h-3 mr-1" /> Upload Signed Copy</>
                          )}
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* === SIGNED COPIES === */}
        {mySignedDocs.length > 0 && (
          <div>
            <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
              {isOwner ? 'All Signed Documents' : 'Your Signed Documents'}
            </h4>
            <div className="space-y-2">
              {mySignedDocs.map((doc) => {
                const meta = DOC_META[doc.document_type];
                if (!meta) return null;
                const storeNames = (doc.covered_store_ids || [])
                  .map((sid) => stores?.find((s) => s.id === sid)?.store_name || sid)
                  .filter(Boolean);

                return (
                  <div
                    key={doc.id}
                    className="flex items-start gap-3 p-3 border rounded-lg text-sm bg-emerald-50/50 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-900/40"
                  >
                    <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 bg-emerald-100 dark:bg-emerald-900/40">
                      <CheckCircle className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold truncate">{meta.label}</p>
                      <div className="flex items-center gap-2 flex-wrap mt-0.5">
                        <span className="text-xs text-muted-foreground">
                          Signed by <strong>{doc.signed_by_name || 'Unknown'}</strong>
                        </span>
                        {doc.signed_at && (
                          <span className="text-xs text-muted-foreground">
                            on {new Date(doc.signed_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}
                          </span>
                        )}
                      </div>
                      {storeNames.length > 0 && (
                        <div className="flex items-center gap-1 mt-1 flex-wrap">
                          <Building2 className="w-3 h-3 text-muted-foreground" />
                          {storeNames.map((name) => (
                            <Badge key={name} variant="outline" className="text-xs px-1.5 py-0 h-5">{name}</Badge>
                          ))}
                        </div>
                      )}
                      {doc.signed_from_version && (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Template version: {doc.signed_from_version}
                        </p>
                      )}
                      <div className="flex gap-2 mt-2">
                        <Button variant="outline" size="sm" className="text-xs h-7 px-2" onClick={() => handlePrint(doc)}>
                          <Eye className="w-3 h-3 mr-1" /> View Signed Copy
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Instructions for store owners */}
        {!isOwner && (
          <div className="text-xs text-muted-foreground bg-muted/50 rounded-lg p-3 border border-border">
            <p className="font-semibold mb-1">How to complete compliance documents:</p>
            <ol className="list-decimal list-inside space-y-0.5">
              <li>Click <strong>Print</strong> on the IMA and NDA templates</li>
              <li>Print and physically sign the paper copies</li>
              <li>Keep your signed paper copies for your records</li>
              <li>Scan or photograph the signed copies</li>
              <li>Click <strong>Upload Signed Copy</strong> and select the file</li>
            </ol>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
