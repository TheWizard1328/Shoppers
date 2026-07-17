import React, { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Phone, Mail, Shield, FileText, CheckCircle, Clock, Upload, ArrowRight, AlertCircle } from 'lucide-react';
import { formatPhoneNumber } from '../../utils/phoneFormatter';
import { getDriverDisplayName } from '../../utils/driverUtils';
import { base44 } from '@/api/base44Client';
import DriverDocUpload from './DriverDocUpload';

export default function DriverDetailSheet({ driver, currentUser, onClose }) {
  const navigate = useNavigate();
  const [showUpload, setShowUpload] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [requestStatus, setRequestStatus] = useState(null); // null | 'pending' | 'approved' | 'denied' | 'error'
  const [requestMessage, setRequestMessage] = useState('');

  const isDispatcher = currentUser?.app_roles?.includes('dispatcher') && !currentUser?.app_roles?.includes('admin');
  const isAdmin = currentUser?.app_roles?.includes('admin');
  const isOwnProfile = currentUser?.id === driver?.id;

  const avatarColor = driver.app_roles?.includes('admin') ?
    'bg-gradient-to-br from-blue-500 to-blue-600' :
    driver.app_roles?.includes('dispatcher') ?
    'bg-gradient-to-br from-red-500 to-red-600' :
    'bg-gradient-to-br from-emerald-500 to-emerald-600';

  const getDriverDutyStatus = (drv) => {
    const driverStatus = drv?.driver_status ?? 'off_duty';
    switch (driverStatus) {
      case 'on_duty':
        return { label: 'On Duty', color: 'bg-emerald-100 text-emerald-800' };
      case 'on_break':
        return { label: 'On Break', color: 'bg-orange-100 text-orange-800' };
      case 'online':
        return { label: 'Online', color: 'bg-blue-100 text-blue-800' };
      default:
        return { label: 'Off Duty', color: 'bg-red-100 text-red-800' };
    }
  };

  const dutyStatus = getDriverDutyStatus(driver);

  // Request document access (dispatchers)
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
        status: 'pending',
        requested_at: new Date().toISOString()
      });

      // Audit log
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
  }, [currentUser, driver]);

  // View documents (admin direct access)
  const handleViewDocs = useCallback(() => {
    navigate(`/secure-docs/${driver.id}`);
  }, [navigate, driver.id]);

  return (
    <Sheet open={true} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent side="bottom" className="rounded-t-2xl max-h-[85vh] overflow-y-auto" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
        <SheetHeader className="text-left border-b pb-4 mb-4" style={{ borderColor: 'var(--border-slate-100)' }}>
          <div className="flex items-center gap-4">
            {/* Avatar */}
            <div className={`w-12 h-12 rounded-full flex items-center justify-center flex-shrink-0 ${avatarColor}`}>
              <span className="text-white font-bold text-lg">
                {(getDriverDisplayName(driver) || 'D')?.charAt(0).toUpperCase()}
              </span>
            </div>
            {/* Name and Status */}
            <div>
              <SheetTitle className="text-lg font-bold" style={{ color: 'var(--text-slate-900)' }}>
                {getDriverDisplayName(driver)}
              </SheetTitle>
              <div className="flex items-center gap-2 mt-1">
                <Badge className={`text-xs py-0.5 ${dutyStatus.color}`}>
                  {dutyStatus.label}
                </Badge>
                {driver.app_roles?.includes('dispatcher') && (
                  <Badge className="bg-red-50 text-red-700 border border-red-100 text-xs py-0.5">
                    Dispatcher
                  </Badge>
                )}
              </div>
            </div>
          </div>
        </SheetHeader>

        <div className="space-y-6 py-2">
          {/* Contact Details */}
          <div className="space-y-3">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Contact Information
            </h4>
            <div className="space-y-2">
              {driver.phone && (
                <div className="flex items-center gap-3 text-sm" style={{ color: 'var(--text-slate-700)' }}>
                  <Phone className="w-4 h-4 text-slate-400" />
                  <span>{formatPhoneNumber(driver.phone)}</span>
                </div>
              )}
              {driver.email && (
                <div className="flex items-center gap-3 text-sm truncate" style={{ color: 'var(--text-slate-700)' }}>
                  <Mail className="w-4 h-4 text-slate-400 flex-shrink-0" />
                  <span className="truncate">{driver.email}</span>
                </div>
              )}
            </div>
          </div>

          {/* Action Buttons */}
          <div className="space-y-3 pt-2">
            {/* Call button */}
            {driver.phone && (
              <a href={`tel:${driver.phone}`} className="block w-full">
                <Button className="w-full flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white py-2.5 rounded-lg font-medium shadow-sm">
                  <Phone className="w-4 h-4" />
                  Call Driver
                </Button>
              </a>
            )}

            {/* Upload Documents — drivers for themselves, admins for anyone */}
            {(isOwnProfile || isAdmin) && !showUpload && (
              <Button
                onClick={() => setShowUpload(true)}
                className="w-full flex items-center justify-center gap-2 bg-slate-50 text-slate-700 hover:bg-slate-100 border border-slate-200 py-2.5 rounded-lg font-medium shadow-sm"
              >
                <Upload className="w-4 h-4" />
                {isOwnProfile ? 'Upload My Documents' : 'Upload Documents'}
              </Button>
            )}

            {/* Document upload section */}
            {showUpload && (
              <DriverDocUpload
                driver={driver}
                currentUser={currentUser}
                onClose={() => setShowUpload(false)}
              />
            )}

            {/* Dispatcher: Request Documents */}
            {isDispatcher && (
              <Button
                onClick={handleRequestDocs}
                disabled={requesting || requestStatus === 'pending'}
                className="w-full flex items-center justify-center gap-2 bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-200 py-2.5 rounded-lg font-medium shadow-sm disabled:opacity-50"
              >
                <FileText className="w-4 h-4" />
                {requesting ? 'Sending Request...' : requestStatus === 'pending' ? 'Request Sent' : 'Request Documents'}
              </Button>
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

            {/* Admin: View Documents directly */}
            {isAdmin && (
              <div className="space-y-2">
                <Button
                  onClick={handleViewDocs}
                  className="w-full flex items-center justify-center gap-2 bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-200 py-2.5 rounded-lg font-medium shadow-sm"
                >
                  <FileText className="w-4 h-4" />
                  View Documents
                  <ArrowRight className="w-4 h-4" />
                </Button>
                <p className="text-center text-xs text-slate-400 italic">
                  Admins have direct access — no approval needed
                </p>
              </div>
            )}

            {/* Driver viewing own profile — link to secure viewer */}
            {isOwnProfile && !showUpload && (
              <Button
                onClick={handleViewDocs}
                className="w-full flex items-center justify-center gap-2 bg-slate-50 text-slate-700 hover:bg-slate-100 border border-slate-200 py-2.5 rounded-lg font-medium shadow-sm"
              >
                <Shield className="w-4 h-4" />
                View My Documents
              </Button>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
