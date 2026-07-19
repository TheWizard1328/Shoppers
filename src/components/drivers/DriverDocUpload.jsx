import React, { useState, useRef, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { FileText, Upload, Trash2, Shield, X, CheckCircle, AlertCircle } from 'lucide-react';

const DOC_TYPES = [
  { value: 'license', label: "Driver's License" },
  { value: 'background_check', label: 'Background Check' },
  { value: 'vehicle_registration', label: 'Vehicle Registration' },
  { value: 'vehicle_insurance', label: 'Vehicle Insurance' }
];

export default function DriverDocUpload({ driver, currentUser, onUploaded, onClose }) {
  const [selectedType, setSelectedType] = useState('license');
  const [expiryDate, setExpiryDate] = useState('');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [documents, setDocuments] = useState([]);
  const [loading, setLoading] = useState(false);
  const fileInputRef = useRef(null);
  const cameraInputRef = useRef(null);

  const isAdmin = currentUser?.app_roles?.includes('admin');
  const isOwnProfile = currentUser?.id === driver?.id;

  const loadDocuments = useCallback(async () => {
    if (!driver?.id) return;
    setLoading(true);
    try {
      const docs = await base44.entities.DriverDocument.list({
        filter: { driver_id: driver.id },
        sort: '-uploaded_at'
      });
      setDocuments(docs || []);
    } catch (err) {
      console.error('Failed to load documents:', err);
    } finally {
      setLoading(false);
    }
  }, [driver?.id]);

  React.useEffect(() => {
    loadDocuments();
  }, [loadDocuments]);

  const handleFile = async (file) => {
    if (!file) return;
    
    // Validate file size (max 10MB)
    if (file.size > 10 * 1024 * 1024) {
      setError('File too large. Maximum size is 10MB.');
      return;
    }

    // Validate file type
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    if (!allowedTypes.includes(file.type)) {
      setError('Invalid file type. Please upload a photo (JPG, PNG, WebP) or PDF.');
      return;
    }

    setError(null);
    setUploading(true);

    try {
      // Read file as base64 for upload
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const base64Data = reader.result;

          // Convert base64 data URL to Blob for upload
          const byteString = atob(base64Data.split(',')[1]);
          const mimeType = base64Data.split(',')[0].split(':')[1].split(';')[0];
          const ab = new ArrayBuffer(byteString.length);
          const ia = new Uint8Array(ab);
          for (let i = 0; i < byteString.length; i++) ia[i] = byteString.charCodeAt(i);
          const blob = new Blob([ab], { type: mimeType });

          // Upload to private storage via the Core integration
          const uploadResult = await base44.integrations.Core.UploadPrivateFile({ file: blob });

          const fileUri = uploadResult?.file_uri || uploadResult?.uri || uploadResult;
          
          // Create the DriverDocument record
          await base44.entities.DriverDocument.create({
            driver_id: driver.id,
            driver_name: driver.full_name || driver.email || 'Unknown',
            document_type: selectedType,
            file_uri: fileUri,
            mime_type: file.type,
            file_size: file.size,
            uploaded_at: new Date().toISOString(),
            uploaded_by: currentUser?.id,
            uploaded_by_name: currentUser?.full_name || currentUser?.email || 'Unknown',
            document_expiry_date: expiryDate || null
          });

          // Audit log
          try {
            await base44.entities.DocAuditLog.create({
              viewer_id: currentUser?.id,
              viewer_name: currentUser?.full_name || currentUser?.email,
              action: 'uploaded',
              driver_id: driver.id,
              driver_name: driver.full_name || driver.email,
              doc_ids: [],
              viewed_at: new Date().toISOString(),
              user_agent: navigator.userAgent
            });
          } catch (e) {
            console.warn('Audit log failed:', e);
          }

          setSuccess(`${DOC_TYPES.find(t => t.value === selectedType)?.label} uploaded successfully.`);
          setExpiryDate('');
          if (fileInputRef.current) fileInputRef.current.value = '';
          if (cameraInputRef.current) cameraInputRef.current.value = '';
          await loadDocuments();
          if (onUploaded) onUploaded();
        } catch (err) {
          console.error('Upload error:', err);
          setError('Failed to upload: ' + (err.message || 'Unknown error'));
        } finally {
          setUploading(false);
        }
      };
      reader.onerror = () => {
        setError('Failed to read file.');
        setUploading(false);
      };
      reader.readAsDataURL(file);
    } catch (err) {
      setError('Upload failed: ' + (err.message || ''));
      setUploading(false);
    }
  };

  const handleDelete = async (docId) => {
    if (!confirm('Delete this document? This cannot be undone.')) return;
    try {
      await base44.entities.DriverDocument.delete(docId);
      await loadDocuments();
    } catch (err) {
      setError('Failed to delete: ' + (err.message || ''));
    }
  };

  const canUpload = isAdmin || isOwnProfile;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Shield className="w-5 h-5 text-blue-600" />
          <h3 className="font-semibold text-slate-900">
            {isOwnProfile ? 'My Documents' : `Documents — ${driver?.full_name || 'Driver'}`}
          </h3>
        </div>
        {onClose && (
          <Button onClick={onClose} variant="ghost" size="sm">
            <X className="w-4 h-4" />
          </Button>
        )}
      </div>

      {/* Upload section — drivers can upload their own, admins can upload for anyone */}
      {canUpload && (
        <Card className="border-dashed border-2 border-slate-300">
          <CardContent className="p-4 space-y-3">
            <div className="flex flex-wrap gap-2">
              {DOC_TYPES.map((type) => (
                <button
                  key={type.value}
                  onClick={() => setSelectedType(type.value)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    selectedType === type.value
                      ? 'bg-blue-600 text-white'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  {type.label}
                </button>
              ))}
            </div>

            <div>
              <label className="text-xs text-slate-500 font-medium">Document Expiry Date (optional)</label>
              <input
                type="date"
                value={expiryDate}
                onChange={(e) => setExpiryDate(e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-300 text-sm"
              />
            </div>

            <div className="flex gap-2">
              <Button
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                variant="outline"
                size="sm"
                className="gap-2"
              >
                <Upload className="w-4 h-4" />
                Choose File
              </Button>
              <Button
                onClick={() => cameraInputRef.current?.click()}
                disabled={uploading}
                variant="outline"
                size="sm"
                className="gap-2"
              >
                <Upload className="w-4 h-4" />
                Take Photo
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,application/pdf"
                className="hidden"
                onChange={(e) => handleFile(e.target.files?.[0])}
              />
              <input
                ref={cameraInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                onChange={(e) => handleFile(e.target.files?.[0])}
              />
            </div>

            {uploading && (
              <div className="flex items-center gap-2 text-sm text-blue-600">
                <div className="w-4 h-4 border-2 border-blue-200 border-t-blue-600 rounded-full animate-spin" />
                Uploading...
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Error / Success messages */}
      {error && (
        <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 rounded-lg p-3">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}
      {success && (
        <div className="flex items-center gap-2 text-sm text-emerald-600 bg-emerald-50 rounded-lg p-3">
          <CheckCircle className="w-4 h-4 flex-shrink-0" />
          {success}
        </div>
      )}

      {/* Document list */}
      {loading ? (
        <div className="text-center py-4 text-sm text-slate-500">Loading documents...</div>
      ) : documents.length === 0 ? (
        <div className="text-center py-8 text-sm text-slate-500">
          No documents uploaded yet.
        </div>
      ) : (
        <div className="space-y-2">
          {documents.map((doc) => (
            <Card key={doc.id} className="hover:shadow-sm transition-shadow">
              <CardContent className="p-3 flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-blue-50 flex items-center justify-center flex-shrink-0">
                  <FileText className="w-4 h-4 text-blue-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm text-slate-900 capitalize">
                    {doc.document_type?.replace(/_/g, ' ')}
                  </p>
                  <div className="flex items-center gap-2 flex-wrap mt-0.5">
                    <span className="text-xs text-slate-500">
                      {new Date(doc.uploaded_at || doc.created_date).toLocaleDateString()}
                    </span>
                    {doc.document_expiry_date && (
                      <Badge variant="outline" className="text-xs h-4 py-0">
                        Exp: {new Date(doc.document_expiry_date).toLocaleDateString()}
                      </Badge>
                    )}
                    {doc.uploaded_by_name && (
                      <span className="text-xs text-slate-400">
                        by {doc.uploaded_by_name}
                      </span>
                    )}
                  </div>
                </div>
                {canUpload && (
                  <Button
                    onClick={() => handleDelete(doc.id)}
                    variant="ghost"
                    size="sm"
                    className="text-red-500 hover:text-red-700 hover:bg-red-50"
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {!canUpload && (
        <p className="text-xs text-slate-400 text-center">
          Only the driver or an admin can upload documents.
        </p>
      )}
    </div>
  );
}