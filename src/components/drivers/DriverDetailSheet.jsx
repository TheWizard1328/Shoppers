import React from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Phone, Mail, Shield, FileText, CheckCircle } from 'lucide-react';
import { formatPhoneNumber } from '../../utils/phoneFormatter';
import { getDriverDisplayName } from '../../utils/driverUtils';

export default function DriverDetailSheet({ driver, currentUser, onClose }) {
  const isDispatcher = currentUser?.app_roles?.includes('dispatcher') && !currentUser?.app_roles?.includes('admin');
  const isAdmin = currentUser?.app_roles?.includes('admin');

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
            {driver.phone && (
              <a href={`tel:${driver.phone}`} className="block w-full">
                <Button className="w-full flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white py-2.5 rounded-lg font-medium shadow-sm">
                  <Phone className="w-4 h-4" />
                  Call Driver
                </Button>
              </a>
            )}

            {isDispatcher && (
              <Button
                onClick={() => {
                  console.log('Request docs for', driver.id);
                }}
                className="w-full flex items-center justify-center gap-2 bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-200 py-2.5 rounded-lg font-medium shadow-sm"
              >
                <FileText className="w-4 h-4" />
                Request Documents
              </Button>
            )}

            {isAdmin && (
              <div className="space-y-2">
                <Button
                  onClick={() => {
                    console.log('Admin direct view docs for', driver.id);
                  }}
                  className="w-full flex items-center justify-center gap-2 bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-200 py-2.5 rounded-lg font-medium shadow-sm"
                >
                  <FileText className="w-4 h-4" />
                  View Documents
                </Button>
                <p className="text-center text-xs text-slate-400 italic">
                  Admins have direct access
                </p>
              </div>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
