import React, { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { Menu, X, MoreVertical, QrCode } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { motion } from 'framer-motion';
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
  adminImportEnabled,
  onAdminImportToggle,
  themePreference,
  onThemeChange,
  cities,
  onPatientImportClick,
  onDeliveryImportClick,
  onInviteQRClick,
  onCurrentUserUpdate
}) {
  const location = useLocation();

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

  const handleMenuButtonClick = (e) => {
    e.stopPropagation();
    onSidebarToggle();
  };

  if (!isMobile && !isTabletPortrait) {
    return null;
  }

  return (
    <motion.header
      initial={{ y: -60 }}
      animate={{ y: 0 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      data-mobile-header
      className="mobile-header border-b sticky top-0 z-50"
      style={{ 
        borderColor: 'var(--border-slate-200)', 
        background: 'var(--bg-white)',
      }}
    >
      {/* Safe area spacer - pushes content down on notched devices without offsetting touch targets */}
      <div style={{ height: 'env(safe-area-inset-top, 0px)' }} />
      <div className="w-full flex items-center justify-between gap-2 px-4 py-3">
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={handleMenuButtonClick}
            className="p-2 hover:bg-slate-100 rounded-lg transition-colors flex-shrink-0">
            {sidebarOpen ? (
              <X className="w-6 h-6 text-slate-700" />
            ) : (
              <Menu className="w-6 h-6 text-slate-700" />
            )}
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
                <Button variant="ghost" size="sm" className="h-9 w-9 p-0">
                  <MoreVertical className="w-5 h-5 text-slate-500" />
                </Button>
              </DropdownMenuTrigger>
              <SettingsMenu
                currentUser={currentUser}
                realUser={realUser}
                isAppOwner={isAppOwner(currentUser)}
                adminImportEnabled={adminImportEnabled}
                onAdminImportToggle={onAdminImportToggle}
                themePreference={themePreference}
                onThemeChange={onThemeChange}
                cities={cities}
                onPatientImportClick={onPatientImportClick}
                onDeliveryImportClick={onDeliveryImportClick}
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
              onClick={onInviteQRClick}
              className="p-2 hover:bg-slate-100 rounded-lg transition-colors"
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
    </motion.header>
  );
}