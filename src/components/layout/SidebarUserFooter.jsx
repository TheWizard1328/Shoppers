import React, { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Phone, MessageCircle, QrCode, LogOut } from 'lucide-react';
import { formatRoles, userHasRole } from '@/components/utils/userRoles';
import { getDriverDisplayName } from '@/components/utils/driverUtils';
import { formatPhoneNumber } from '@/components/utils/phoneFormatter';
import ExportRouteButton from '@/components/deliveries/ExportRouteButton';
import { globalFilters } from '@/components/utils/globalFilters';
import { User } from '@/entities/User';

export default function SidebarUserFooter({
  currentUser,
  realUser,
  impersonatingUser,
  users,
  unreadMessageCount = 0,
  onOpenMessaging,
  onOpenInviteQR,
  onImpersonate,
  onStopImpersonating,
  stores,
  filteredDeliveries,
  impersonationArea
}) {
  const canShowExportRoute = currentUser ? userHasRole(currentUser, 'dispatcher') || userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'driver') : false;
  const [selectedDriverId, setSelectedDriverId] = useState(() => globalFilters.getSelectedDriverId() || 'all');
  const [selectedDateStr, setSelectedDateStr] = useState(() => globalFilters.getSelectedDate());

  useEffect(() => {
    const unsubscribe = globalFilters.subscribe(() => {
      setSelectedDriverId(globalFilters.getSelectedDriverId() || 'all');
      setSelectedDateStr(globalFilters.getSelectedDate());
    });

    return unsubscribe;
  }, []);

  if (!currentUser) {
    return (
      <div className="border-t p-4 flex-shrink-0" style={{ borderColor: 'var(--border-slate-200)', background: 'var(--bg-white)' }}>
        <div className="space-y-2">
          <div className="text-sm text-slate-500 mb-2">Not logged in</div>
          <Button
            onClick={async () => {
              try {
                sessionStorage.clear();
                const currentUrl = window.location.origin + window.location.pathname;
                await User.loginWithRedirect(currentUrl);
              } catch (error) {
                console.error('Login failed:', error);
                window.location.href = '/';
              }
            }}
            className="w-full gap-2 bg-emerald-500 hover:bg-emerald-600">

            Log In
          </Button>
        </div>
      </div>);

  }

  const selectedDate = selectedDateStr ? new Date(selectedDateStr + 'T00:00:00') : new Date();

  return (
    <div className="px-2 flex-shrink-0 border-t" style={{ borderColor: 'var(--border-slate-200)', background: 'var(--bg-white)' }}>
      <div>
        <div className="px-2 rounded-lg flex items-center gap-3">


          <div className={`w-9 h-9 rounded-full flex items-center justify-center relative flex-shrink-0 ${
          impersonatingUser ? 'bg-gradient-to-br from-yellow-500 to-yellow-600' :
          userHasRole(currentUser, 'admin') ? 'bg-gradient-to-br from-blue-500 to-blue-600' :
          userHasRole(currentUser, 'dispatcher') ? 'bg-gradient-to-br from-red-500 to-red-600' :
          userHasRole(currentUser, 'driver') ? 'bg-gradient-to-br from-emerald-500 to-emerald-600' :
          'bg-gradient-to-br from-gray-400 to-gray-500'}`
          }>
            <span className="text-white font-bold text-sm">{(getDriverDisplayName(currentUser) || 'U')?.charAt(0)}</span>
          </div>
          <div className="flex-1 min-w-0">
            {impersonatingUser &&
            <p className="text-xs font-semibold text-yellow-800 mb-1">Viewing As</p>
            }
            <p className="font-semibold text-sm truncate" style={{ color: 'var(--text-slate-900)' }}>
              {getDriverDisplayName(currentUser)}
            </p>
            <p className="text-xs truncate capitalize" style={{ color: 'var(--text-slate-500)' }}>
              {formatRoles(currentUser)}
            </p>
            {currentUser.phone &&
            <div className="flex items-center gap-2 text-xs text-slate-500">
                <Phone className="w-3 h-3" />
                <a href={`tel:${currentUser.phone}`} className="hover:text-slate-700 transition-colors">
                  {formatPhoneNumber(currentUser.phone)}
                </a>
              </div>
            }
          </div>
          <div className="flex flex-col items-center">
            <button
              onClick={onOpenMessaging} className="px-2 py-0 rounded-lg hover:bg-slate-100 transition-colors relative"

              title="Messages">

              <MessageCircle className="w-5 h-5 text-slate-500 hover:text-slate-700" fill={unreadMessageCount > 0 ? '#10b981' : 'none'} />
              {unreadMessageCount > 0 &&
              <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] bg-blue-500 text-xs font-bold rounded-full flex items-center justify-center px-1 border-2 border-white" style={{ color: '#ffffff' }}>
                  {unreadMessageCount > 9 ? '9+' : unreadMessageCount}
                </span>
              }
            </button>
            <button
              onClick={onOpenInviteQR} className="px-2 py-0 rounded-lg hover:bg-slate-100 transition-colors"

              title="Generate Invite QR Code">

              <QrCode className="w-5 h-5 text-slate-500 hover:text-slate-700" />
            </button>
          </div>
        </div>

        {impersonatingUser &&
        <Button onClick={onStopImpersonating} variant="destructive" className="w-full gap-2 mb-3">
            <LogOut className="w-4 h-4" /> Stop Viewing As
          </Button>
        }

        {/* Impersonation area (provided by parent) */}
        {impersonationArea}

        {canShowExportRoute &&
        <div className="mt-3">
            <ExportRouteButton
            currentUser={currentUser}
            driverFilter={selectedDriverId}
            selectedDate={selectedDate}
            driverFilteredDeliveries={filteredDeliveries} />

          </div>
        }
      </div>
    </div>);

}