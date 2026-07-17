import React, { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Shield, FileText, CheckCircle, Clock, Upload, ArrowRight, AlertCircle } from 'lucide-react';
import { getDriverDisplayName } from '../utils/driverUtils';
import { base44 } from '@/api/base44Client';
import DriverDocUpload from './DriverDocUpload';

const DOC_TYPES = [
  { value: 'license', label: "Driver's License" },
  { value: 'background_check', label: 'Background Check' },
  { value: 'vehicle_registration', label: 'Vehicle Registration' },
  { value: 'vehicle_insurance', label: 'Vehicle Insurance' },
];

export default function DriverDetailSheet({ driver, currentUser, onClose }) {
  const navigate = useNavigate();
  const [showUpload, setShowUpload] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [requestStatus, setRequestStatus] = useState(null);
  const [requestMessage, setRequestMessage] = useState('');
  const [selectedDocTypes, setSelectedDocTypes] = useState([]);

  const isDispatcher = currentUser?.app_roles?.includes('dispatcher') && !currentUser?.app_roles?.includes('admin');
  const isAdmin = currentUser?.app_roles?.includes('admin');
  const isOwnProfile = currentUser?.id === driver?.id;

  const avatarColor = driver.app_roles?.includes('admin')
    ? 'bg-gradient-to-br from-blue-500 to-blue-600'
    : driver.app_roles?.includes('dispatcher')
    ? 'bg-gradient-to-br from-red-500 to-red-600'
    : 'bg-gradient-to-br from-emerald-500 to-emerald-600';

  const getDriverDutyStatus = (drv) => {
    switch (drv?.driver_status ?? 'off_duty') {
      case 'on_duty':  return { label: 'On Duty',  color: 'bg-emerald-100 text-emerald-800' };
      case 'on_break': return { label: 'On Break', color: 'bg-orange-100 text-orange-800' };
      case 'online':   return { label: 'Online',   color: 'bg-blue-100 text-blue-800' };
      default:         return { label: 'Off Duty', color: 'bg-red-100 text-red-800' };
    }
  };

  const dutyStatus = getDriverDutyStatus(driver);

  const toggleDocType = (value) => {
    setSelectedDocTypes((prev) =>
      prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]
    );
  };

  const handleRequestDocs = useCallback(async () => {
    setRequesting(true);
    setRequestStatus(null);
    setRequestMessage('');
    try {
      await base44.entities.DocAccessRequest.create({
        requester_id: currentUser.id,
        requester_name: currentUser.full_name || currentUser.email || 'Unknown',
        driver_id: driver.id,
        driver_name: getDriverDisplayName(driver),
        requested_doc_types: selectedDocTypes,
        status: 'pending',
        requested_at: new Date().toISOString()
      });

      try {
        await base44.entities.DocAuditLog.create({
          viewer_id: currentUser.id,
          viewer_name: currentUser.full_name || currentUser.email,
          action: 'requested',
          driver_id: driver.id,
          driver_name: getDriverDisplayName(driver),
          viewed_at: new Date().toISOString(),
          user_agent: navigator.userAgent
        });
      } catch (e) {
        console.warn('Audit log failed:', e);
      }

      setRequestStatus('pending');
      setRequestMessage('Request sent. An admin will review and approve access.');
    } catch (err) {
      console.error('Request failed:', err);
      setRequestStatus('error');
      setRequestMessage(err.message || 'Failed to send request');
    } finally {
      setRequesting(false);
    }
  }, [currentUser, driver, selectedDocTypes]);

  const handleViewDocs = useCallback(() => {
    navigate(`/secure-docs/${driver.id}`);
  }, [navigate, driver.id]);

  return (
    <Dialog open={true} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-sm w-full rounded-2xl p-0 overflow-hidden" style={{ background: 'var(--bg-white)' }}>
        {/* Header */}
        <DialogHeader className="px-5 pt-5 pb-4 border-b" style={{ borderColor: 'var(--border-slate-100)' }}>
          <div className="flex items-center gap-3">
            <div className={`w-11 h-11 rounded-full flex items-center justify-center flex-shrink-0 ${avatarColor}`}>
              <span className="text-white font-bold text-base">
                {(getDriverDisplayName(driver) || 'D')?.charAt(0).toUpperCase()}
              </span>
            </div>
            <div>
              <DialogTitle className="text-base font-bold leading-tight" style={{ color: 'var(--text-slate-900)' }}>
                {getDriverDisplayName(driver)}
              </DialogTitle>
              <div className="flex items-center gap-2 mt-1">
                <Badge className={`text-xs py-0.5 ${dutyStatus.color}`}>{dutyStatus.label}</Badge>
                {driver.app_roles?.includes('dispatcher') && (
                  <Badge className="bg-red-50 text-red-700 border border-red-100 text-xs py-0.5">Dispatcher</Badge>
                )}
              </div>
            </div>
          </div>
        </DialogHeader>

        <div className="px-5 py-4 space-y-4">
          {/* Upload section */}
          {(isOwnProfile || isAdmin) && !showUpload && (
            <Button
              onClick={() => setShowUpload(true)}
              className="w-full flex items-center justify-center gap-2 bg-slate-50 text-slate-700 hover:bg-slate-100 border border-slate-200 py-2.5 rounded-lg font-medium"
            >
              <Upload className="w-4 h-4" />
              {isOwnProfile ? 'Upload My Documents' : 'Upload Documents'}
            </Button>
          )}

          {showUpload && (
            <DriverDocUpload driver={driver} currentUser={currentUser} onClose={() => setShowUpload(false)} />
          )}

          {/* Dispatcher: doc type checklist + request button */}
          {isDispatcher && !requestStatus && (
            <div className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Select Documents to Request</p>
              <div className="space-y-2">
                {DOC_TYPES.map((type) => (
                  <label
                    key={type.value}
                    className="flex items-center gap-3 cursor-pointer group"
                    onClick={() => toggleDocType(type.value)}
                  >
                    <div className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 transition-colors ${
                      selectedDocTypes.includes(type.value)
                        ? 'bg-blue-600 border-blue-600'
                        : 'border-slate-300 group-hover:border-blue-400'
                    }`}>
                      {selectedDocTypes.includes(type.value) && (
                        <svg className="w-2.5 h-2.5 text-white" viewBox="0 0 10 8" fill="none">
                          <path d="M1 4l3 3 5-6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      )}
                    </div>
                    <span className="text-sm text-slate-700">{type.label}</span>
                  </label>
                ))}
              </div>
              <Button
                onClick={handleRequestDocs}
                disabled={requesting || selectedDocTypes.length === 0}
                className="w-full flex items-center justify-center gap-2 bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-200 py-2.5 rounded-lg font-medium disabled:opacity-50"
              >
                <FileText className="w-4 h-4" />
                {requesting ? 'Sending...' : 'Request Documents'}
              </Button>
            </div>
          )}

          {/* Request status feedback */}
          {requestStatus === 'pending' && (
            <div className="flex items-start gap-2 text-sm text-blue-600 bg-blue-50 rounded-lg p-3">
              <Clock className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-medium">Request sent to admin</p>
                <p className="text-xs text-blue-500 mt-0.5">{requestMessage}</p>
              </div>
            </div>
          )}
          {requestStatus === 'error' && (
            <div className="flex items-start gap-2 text-sm text-red-600 bg-red-50 rounded-lg p-3">
              <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-medium">Request failed</p>
                <p className="text-xs text-red-500 mt-0.5">{requestMessage}</p>
              </div>
            </div>
          )}

          {/* Admin: View Documents */}
          {isAdmin && (
            <div className="space-y-1">
              <Button
                onClick={handleViewDocs}
                className="w-full flex items-center justify-center gap-2 bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-200 py-2.5 rounded-lg font-medium"
              >
                <FileText className="w-4 h-4" />
                View Documents
                <ArrowRight className="w-4 h-4" />
              </Button>
              <p className="text-center text-xs text-slate-400 italic">Admins have direct access</p>
            </div>
          )}

          {/* Driver viewing own docs */}
          {isOwnProfile && !showUpload && (
            <Button
              onClick={handleViewDocs}
              className="w-full flex items-center justify-center gap-2 bg-slate-50 text-slate-700 hover:bg-slate-100 border border-slate-200 py-2.5 rounded-lg font-medium"
            >
              <Shield className="w-4 h-4" />
              View My Documents
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}