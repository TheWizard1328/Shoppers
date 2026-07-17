import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Shield, FileText, AlertTriangle, Clock, ArrowLeft, Eye } from 'lucide-react';

export default function SecureDocViewer() {
  const { driverId } = useParams();
  const navigate = useNavigate();
  const [accessRequest, setAccessRequest] = useState(null);
  const [documents, setDocuments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [timeRemaining, setTimeRemaining] = useState(null);
  const [viewingDoc, setViewingDoc] = useState(null);
  const [docUrl, setDocUrl] = useState(null);
  const [docLoading, setDocLoading] = useState(false);
  const canvasRef = useRef(null);
  const containerRef = useRef(null);

  // Check access and load documents
  useEffect(() => {
    const checkAccessAndLoad = async () => {
      try {
        setLoading(true);
        const me = await base44.auth.me();
        if (!me) {
          setError('Not authenticated');
          return;
        }

        // Check if admin — admins have direct access
        const isAdmin = me.app_roles?.includes('admin');
        
        if (!isAdmin) {
          // Look for an active approved DocAccessRequest for this driver
          const requests = await base44.entities.DocAccessRequest.list({
            filter: {
              requester_id: me.id,
              driver_id: driverId,
              status: 'approved'
            },
            sort: '-approved_at',
            limit: 5
          });

          const activeRequest = (requests || []).find(r => {
            if (!r.approved_at) return false;
            // Check midnight expiry
            const now = new Date();
            const expiresAt = new Date(r.expires_at);
            if (now > expiresAt) return false;
            // Check 30-min from first view
            if (r.first_viewed_at) {
              const viewTime = new Date(r.first_viewed_at);
              const thirtyMinLater = new Date(viewTime.getTime() + 30 * 60 * 1000);
              if (now > thirtyMinLater) return false;
            }
            return true;
          });

          if (!activeRequest) {
            setError('No active document access. You need an approved request that has not expired.');
            return;
          }

          setAccessRequest(activeRequest);

          // Set first_viewed_at if not already set
          if (!activeRequest.first_viewed_at) {
            try {
              await base44.entities.DocAccessRequest.update(activeRequest.id, {
                first_viewed_at: new Date().toISOString()
              });
              setAccessRequest({ ...activeRequest, first_viewed_at: new Date().toISOString() });
            } catch (e) {
              console.warn('Could not set first_viewed_at:', e);
            }
          }
        }

        // Load documents for this driver
        const docs = await base44.entities.DriverDocument.list({
          filter: { driver_id: driverId },
          sort: '-uploaded_at'
        });
        setDocuments(docs || []);
      } catch (err) {
        console.error('SecureDocViewer error:', err);
        setError(err.message || 'Failed to load documents');
      } finally {
        setLoading(false);
      }
    };

    checkAccessAndLoad();
  }, [driverId]);

  // Countdown timer
  useEffect(() => {
    if (!accessRequest?.first_viewed_at && !accessRequest?.expires_at) return;

    const updateTimer = () => {
      const now = new Date();
      
      // 30-min window from first view
      if (accessRequest.first_viewed_at) {
        const viewTime = new Date(accessRequest.first_viewed_at);
        const expiry = new Date(viewTime.getTime() + 30 * 60 * 1000);
        const remaining = expiry.getTime() - now.getTime();
        
        // Also check midnight expiry
        const midnightExpiry = accessRequest.expires_at ? new Date(accessRequest.expires_at) : null;
        const midnightRemaining = midnightExpiry ? midnightExpiry.getTime() - now.getTime() : Infinity;
        
        const effectiveRemaining = Math.min(remaining, midnightRemaining);
        
        if (effectiveRemaining <= 0) {
          setTimeRemaining(null);
          setError('Access has expired.');
          setViewingDoc(null);
        } else {
          const mins = Math.floor(effectiveRemaining / 60000);
          const secs = Math.floor((effectiveRemaining % 60000) / 1000);
          setTimeRemaining(`${mins}:${secs.toString().padStart(2, '0')}`);
        }
      }
    };

    updateTimer();
    const interval = setInterval(updateTimer, 1000);
    return () => clearInterval(interval);
  }, [accessRequest]);

  // View a document
  const handleViewDoc = useCallback(async (doc) => {
    setDocLoading(true);
    setViewingDoc(doc);
    setDocUrl(null);
    try {
      const me = await base44.auth.me();
      const result = await base44.functions.invoke('serveDriverDoc', {
        doc_id: doc.id,
        viewer_id: me.id,
        viewer_name: me.full_name || me.email || 'Unknown'
      });
      
      if (result?.file_url) {
        setDocUrl(result.file_url);
      } else {
        setError('Failed to load document');
      }

      // Log the view in audit trail
      try {
        await base44.entities.DocAuditLog.create({
          viewer_id: me.id,
          viewer_name: me.full_name || me.email,
          action: 'viewed',
          driver_id: driverId,
          driver_name: doc.driver_name,
          doc_ids: [doc.id],
          viewed_at: new Date().toISOString(),
          user_agent: navigator.userAgent
        });
      } catch (e) {
        console.warn('Audit log failed:', e);
      }
    } catch (err) {
      console.error('View doc error:', err);
      setError('Failed to load document: ' + (err.message || ''));
    } finally {
      setDocLoading(false);
    }
  }, [driverId]);

  // Render image to canvas with watermark
  useEffect(() => {
    if (!docUrl || !canvasRef.current || !viewingDoc) return;

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      
      // Scale to fit container width (max 800px)
      const maxWidth = Math.min(containerRef.current?.clientWidth || 800, 800);
      const scale = Math.min(1, maxWidth / img.width);
      canvas.width = img.width * scale;
      canvas.height = img.height * scale;
      
      // Draw the image
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      
      // Watermark overlay
      const me = accessRequest?.requester_name || 'Viewer';
      const now = new Date();
      const ts = `${now.toLocaleDateString()} ${now.toLocaleTimeString()}`;
      const watermarkText = `${me} • ${ts} • CONFIDENTIAL`;
      
      ctx.font = `${Math.max(12, canvas.width * 0.025)}px sans-serif`;
      ctx.fillStyle = 'rgba(255, 0, 0, 0.6)';
      ctx.textAlign = 'center';
      
      // Diagonal watermark across center
      ctx.save();
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate(-Math.PI / 6);
      ctx.fillText(watermarkText, 0, 0);
      ctx.restore();
      
      // Top and bottom bars
      ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
      ctx.fillRect(0, 0, canvas.width, 30 * scale);
      ctx.fillRect(0, canvas.height - 30 * scale, canvas.width, 30 * scale);
      
      ctx.font = `${Math.max(10, canvas.width * 0.02)}px sans-serif`;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.textAlign = 'left';
      ctx.fillText(`CONFIDENTIAL — ${me}`, 10, 20 * scale);
      ctx.textAlign = 'right';
      ctx.fillText(ts, canvas.width - 10, 20 * scale);
      ctx.textAlign = 'center';
      ctx.fillText('RxDeliver Secure Document — Do Not Copy', canvas.width / 2, canvas.height - 10 * scale);
    };
    img.onerror = () => {
      setError('Failed to load image');
    };
    img.src = docUrl;
  }, [docUrl, viewingDoc, accessRequest]);

  // Disable right-click and keyboard shortcuts
  useEffect(() => {
    const handleContextMenu = (e) => e.preventDefault();
    const handleKeyDown = (e) => {
      // Block Ctrl+S, Ctrl+P, Ctrl+C, Ctrl+A, PrintScreen
      if ((e.ctrlKey || e.metaKey) && ['s', 'p', 'c', 'a'].includes(e.key.toLowerCase())) {
        e.preventDefault();
      }
      if (e.key === 'PrintScreen') {
        e.preventDefault();
        // Log screenshot attempt
        console.warn('Screenshot attempt detected');
      }
    };

    document.addEventListener('contextmenu', handleContextMenu);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('contextmenu', handleContextMenu);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="text-center">
          <div className="w-8 h-8 border-4 border-slate-200 border-t-slate-800 rounded-full animate-spin mx-auto mb-4" />
          <p className="text-sm text-slate-600">Verifying access...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-4">
        <Card className="max-w-md w-full">
          <CardContent className="p-6 text-center">
            <AlertTriangle className="w-12 h-12 text-red-500 mx-auto mb-4" />
            <h2 className="text-lg font-semibold text-slate-900 mb-2">Access Denied</h2>
            <p className="text-sm text-slate-600 mb-4">{error}</p>
            <Button onClick={() => navigate(-1)} variant="outline" className="gap-2">
              <ArrowLeft className="w-4 h-4" />
              Go Back
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50" ref={containerRef}>
      {/* Header */}
      <div className="sticky top-0 z-50 bg-white border-b border-slate-200 shadow-sm">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Button onClick={() => navigate(-1)} variant="ghost" size="sm" className="gap-2">
              <ArrowLeft className="w-4 h-4" />
              Back
            </Button>
            <div className="flex items-center gap-2">
              <Shield className="w-5 h-5 text-blue-600" />
              <span className="font-semibold text-slate-900">Secure Documents</span>
            </div>
          </div>
          {timeRemaining && (
            <Badge className="gap-1.5 bg-amber-100 text-amber-800">
              <Clock className="w-3.5 h-3.5" />
              {timeRemaining}
            </Badge>
          )}
        </div>
      </div>

      <div className="max-w-4xl mx-auto p-4">
        {/* Document list */}
        {!viewingDoc && (
          <div className="space-y-3">
            <p className="text-sm text-slate-600 mb-4">
              {documents.length} document{documents.length !== 1 ? 's' : ''} available.
              Access expires in <span className="font-semibold text-amber-700">{timeRemaining || '—'}</span> or at midnight, whichever comes first.
            </p>
            {documents.map((doc) => (
              <Card key={doc.id} className="hover:shadow-md transition-shadow cursor-pointer" onClick={() => handleViewDoc(doc)}>
                <CardContent className="p-4 flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center flex-shrink-0">
                    <FileText className="w-5 h-5 text-blue-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-slate-900 capitalize">
                      {doc.document_type?.replace(/_/g, ' ')}
                    </p>
                    <p className="text-xs text-slate-500">
                      Uploaded {new Date(doc.uploaded_at || doc.created_date).toLocaleDateString()}
                      {doc.document_expiry_date && ` • Expires ${new Date(doc.document_expiry_date).toLocaleDateString()}`}
                    </p>
                  </div>
                  <Eye className="w-5 h-5 text-slate-400" />
                </CardContent>
              </Card>
            ))}
            {documents.length === 0 && (
              <Card>
                <CardContent className="py-8 text-center text-slate-500">
                  No documents uploaded for this driver.
                </CardContent>
              </Card>
            )}
          </div>
        )}

        {/* Document viewer */}
        {viewingDoc && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FileText className="w-5 h-5 text-blue-600" />
                <span className="font-medium capitalize">{viewingDoc.document_type?.replace(/_/g, ' ')}</span>
              </div>
              <Button onClick={() => { setViewingDoc(null); setDocUrl(null); }} variant="outline" size="sm">
                Back to list
              </Button>
            </div>

            {docLoading && (
              <div className="flex items-center justify-center py-12">
                <div className="w-8 h-8 border-4 border-slate-200 border-t-slate-800 rounded-full animate-spin" />
              </div>
            )}

            {docUrl && (
              <div className="relative select-none" style={{ userSelect: 'none', WebkitUserSelect: 'none' }}>
                <canvas
                  ref={canvasRef}
                  className="max-w-full rounded-lg shadow-lg"
                  onContextMenu={(e) => e.preventDefault()}
                  onDragStart={(e) => e.preventDefault()}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
