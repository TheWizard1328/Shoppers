import React, { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { ArrowLeft, MoreVertical, QrCode } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import SettingsMenu from './SettingsMenu';
import DriverStatusToggle from './DriverStatusToggle';
import BatteryIndicator from './BatteryIndicator';
import { userHasRole, isAppOwner } from '../utils/userRoles';
import { getDriverDisplayName } from '../utils/driverUtils';
import { base44 } from '@/api/base44Client';
import { clearUserCache } from '../utils/auth';
import { getEffectiveUser } from '../utils/auth';
import { saveSetting } from '../utils/userSettingsManager';

const ROOT_PAGES = ['Dashboard', 'Patients', 'Deliveries', 'DeviceSettings'];

export default function MobileHeader({ 
  logo, 
  sidebarOpen, 
  onSidebarToggle, 
  branding,
  unreadMessageCount,
  onMessagingClick,
  isMobile,
  isTabletPortrait,
  currentUser,
  realUser,
  themePreference,
  onThemeChange,
  cities,
  onInviteQRClick,
  onCurrentUserUpdate
}) {
  const location = useLocation();
  const canGoBack = (window.history.state?.idx ?? 0) > 0;

  // Enable browser back button on nested routes
  useEffect(() => {
    const currentPage = location.pathname.split('/').pop() || 'Dashboard';
    const isRootPage = ROOT_PAGES.includes(currentPage);
    
    if (!isRootPage) {
      window.history.pushState(null, '', window.location.href);
      const handlePopState = () => window.history.back();
      window.addEventListener('popstate', handlePopState);
      return () => window.removeEventListener('popstate', handlePopState);
    }
  }, [location.pathname]);

  const handleBackButtonClick = (e) => {
    e.stopPropagation();
    if (!canGoBack) return;
    window.history.back();
  };

  if (!isMobile && !isTabletPortrait) {
    return null;
  }

  return (
    <header
      data-mobile-header
      className="mobile-header border-b sticky top-0 z-50 overflow-visible"
      style={{ 
        borderColor: 'var(--border-slate-200)', 
        background: 'var(--bg-white)',
        paddingTop: 'env(safe-area-inset-top, 0px)'
      }}
    >
      <div className="w-full min-h-[56px] flex items-center justify-between gap-2 px-4 py-2">
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            type="button"
            onClick={handleBackButtonClick}
            aria-label="Go back"
            className="h-11 w-11 min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-lg transition-colors hover:bg-slate-100 touch-manipulation flex-shrink-0">
            <ArrowLeft className="w-6 h-6 text-slate-700" />
          </button>

          {/* Logo with message badge - Left */}
          <div
            className="flex items-center gap-2 flex-shrink-0 relative cursor-pointer"
            onClick={() => {
              if (unreadMessageCount > 0) {
                onMessagingClick?.();
              }
            }}>
            <img
              src={logo || "https://cdn-icons-png.flaticon.com/512/3843/3843479.png"}
              alt="Company Logo"
              className="w-8 h-8 rounded object-contain"
              style={{ filter: 'var(--image-filter, none)' }}
            />
            {unreadMessageCount > 0 && (
              <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] bg-blue-500 text-xs font-bold rounded-full flex items-center justify-center px-1 border-2 border-white" style={{ color: '#ffffff' }}>
                {unreadMessageCount > 9 ? '9+' : unreadMessageCount}
              </span>
            )}
          </div>
        </div>

        {/* Centered Controls - Only when sidebar is NOT open */}
        {currentUser && !sidebarOpen && (userHasRole(currentUser, 'driver') || userHasRole(currentUser, 'admin')) && (
          <div className="flex-1 flex items-center justify-center gap-2">
            {/* Menu - Left */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-11 w-11 min-h-[44px] min-w-[44px] p-0 touch-manipulation" aria-label="Open header menu">
                  <MoreVertical className="w-5 h-5 text-slate-500" />
                </Button>
              </DropdownMenuTrigger>
              <SettingsMenu
                currentUser={currentUser}
                realUser={realUser}
                isAppOwner={isAppOwner(currentUser)}
                themePreference={themePreference}
                onThemeChange={onThemeChange}
                cities={cities}
                isMobile={true}
              />
            </DropdownMenu>

            {/* Status Toggle - Center */}
            {userHasRole(currentUser, 'driver') && (
              <div style={{ width: 'auto', overflow: 'hidden' }}>
                <DriverStatusToggle
                  currentUser={currentUser}
                  onStatusChange={onCurrentUserUpdate}
                />
              </div>
            )}

            {/* QR Code - Right */}
            <button
              type="button"
              onClick={onInviteQRClick}
              aria-label="Generate invite QR code"
              className="h-11 w-11 min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-lg transition-colors hover:bg-slate-100 touch-manipulation"
              title="Generate Invite QR Code">
              <QrCode className="w-6 h-6 text-slate-500 hover:text-slate-700" />
            </button>
          </div>
        )}

        {/* Battery + User Avatar on far right */}
        {currentUser && (
          <div className="flex items-center gap-2 flex-shrink-0">
            <BatteryIndicator vertical={true} />
            <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
              userHasRole(currentUser, 'admin') ?
                'bg-gradient-to-br from-blue-500 to-blue-600' :
              userHasRole(currentUser, 'dispatcher') ?
                'bg-gradient-to-br from-red-500 to-red-600' :
              userHasRole(currentUser, 'driver') ?
                'bg-gradient-to-br from-emerald-500 to-emerald-600' :
                'bg-gradient-to-br from-gray-400 to-gray-500'}`}>
              <span className="text-white font-bold text-xs">
                {(getDriverDisplayName(currentUser) || 'U')?.charAt(0)}
              </span>
            </div>
          </div>
        )}
      </div>
    </header>
  );
}