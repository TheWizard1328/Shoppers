import React, { useMemo, useState, useEffect } from 'react';
import { ArrowLeft, MoreVertical, QrCode } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import SettingsMenu from './SettingsMenu';
import DriverStatusToggle from './DriverStatusToggle';
import BackgroundLocationNudge from './BackgroundLocationNudge';
import BatteryIndicator from './BatteryIndicator';
import { userHasRole, isAppOwner } from '../utils/userRoles';
import { getDriverDisplayName } from '../utils/driverUtils';
import { useMobileNavigation } from '../navigation/MobileNavigationProvider';
import { getUserAvatarGradient } from './mobileHeaderUtils';
import { globalFilters } from '../utils/globalFilters';

export default function MobileHeader({ 
  logo, 
  sidebarOpen,
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
  onCurrentUserUpdate,
  isOverlayOpen,
  appUsers,
  users,
}) {
  const { canGoBack: canGoBackInTab, goBack } = useMobileNavigation();

  // ── Immersive TEST MODE toggle badge ─────────────────────────────────────────
  // Reflects the immersive test-mode flag (broadcast by useImmersiveMode) so the
  // user badge visibly glows while test mode is engaged. Tapping the badge toggles
  // the flag. Available to all users on primary mobile devices (where MobileHeader
  // renders). Kept as a div badge (not a <button>) to preserve the original circular
  // avatar styling — tap gesture is wired via onClick + role/keyboard handlers.
  const [immersiveTestActive, setImmersiveTestActive] = useState(false);

  useEffect(() => {
    const onState = (e) => setImmersiveTestActive(!!e?.detail?.active);
    window.addEventListener('app-owner-immersive-test-state', onState);
    return () => window.removeEventListener('app-owner-immersive-test-state', onState);
  }, []);

  const handleAvatarClick = () => {
    window.dispatchEvent(new CustomEvent('app-owner-immersive-test-toggle'));
  };

  // Resolve the currently selected driver so the toggle targets them (admin only)
  const selectedDriverTarget = useMemo(() => {
    if (!userHasRole(currentUser, 'admin')) return null;
    const selectedDriverId = globalFilters.getSelectedDriverId();
    if (!selectedDriverId || selectedDriverId === 'all') return null;
    const driverAppUser = (appUsers || []).find((au) => au && au.user_id === selectedDriverId);
    if (!driverAppUser) return null;
    const baseUser = (users || []).find((u) => u && u.id === selectedDriverId);
    return {
      ...(baseUser || {}),
      ...driverAppUser,
      id: driverAppUser.user_id,
      driver_status: driverAppUser.driver_status || 'off_duty',
      current_latitude: driverAppUser.current_latitude,
      current_longitude: driverAppUser.current_longitude,
    };
  }, [currentUser, appUsers, users]);
  const canGoBack = isOverlayOpen || canGoBackInTab || (window.history.state?.idx ?? 0) > 0;

  const handleBackButtonClick = (e) => {
    e.stopPropagation();
    if (!canGoBack) return;
    if (isOverlayOpen) {
      window.history.back();
      return;
    }
    if (canGoBackInTab) {
      goBack();
      return;
    }
    window.history.back();
  };

  // Accept isMobile/isTabletPortrait as props OR fall back to detecting via useDevice
  // (layout passes them; if omitted the component stays visible when rendered)
  const shouldShow = (isMobile !== undefined || isTabletPortrait !== undefined)
    ? (isMobile || isTabletPortrait)
    : true;

  if (!shouldShow) return null;

  return (
    <header
      data-mobile-header
      className="mobile-header border-b sticky top-0 z-50 overflow-visible"
      style={{ 
        borderColor: 'var(--border-slate-200)', 
        background: 'var(--bg-white)',
        // No safe-area-inset-top here — the .app-container already handles it.
        // Adding it here too creates a double-padding dead bar at the top.
      }}
    >
      <div className="w-full min-h-[56px] flex items-center justify-between gap-2 px-4 py-2">
        {/* LEFT: Back button + Logo (+ Menu button for dispatchers) */}
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            type="button"
            onClick={handleBackButtonClick}
            aria-label="Go back"
            disabled={!canGoBack}
            className="h-11 w-11 min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-lg transition-colors hover:bg-slate-100 dark:bg-slate-800 dark:hover:bg-slate-700 disabled:opacity-40 disabled:hover:bg-transparent touch-manipulation flex-shrink-0">
            <ArrowLeft className="w-6 h-6 text-slate-700 dark:text-slate-300" />
          </button>

          {/* Logo with message badge */}
          <div
            className="flex items-center gap-2 flex-shrink-0 relative cursor-pointer"
            onClick={() => {
              if (unreadMessageCount > 0) {
                onMessagingClick?.();
              }
            }}>
            {logo && !logo.includes('placehold') ? (
              <img
                src={logo}
                alt="RxDeliver"
                className="w-8 h-8 rounded object-contain"
                style={{ filter: 'var(--image-filter, none)' }}
                onError={(e) => { e.currentTarget.style.display = 'none'; e.currentTarget.nextSibling && (e.currentTarget.nextSibling.style.display = 'flex'); }}
              />
            ) : null}
            {(!logo || logo.includes('placehold')) && (
              <div className="w-8 h-8 rounded bg-emerald-700 flex items-center justify-center flex-shrink-0">
                <span className="text-white font-bold text-xs">Rx</span>
              </div>
            )}
            {unreadMessageCount > 0 && (
              <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] bg-blue-500 text-xs font-bold rounded-full flex items-center justify-center px-1 border-2 border-white" style={{ color: '#ffffff' }}>
                {unreadMessageCount > 9 ? '9+' : unreadMessageCount}
              </span>
            )}
          </div>

          {/* Menu button for dispatchers — left-aligned next to logo */}
          {currentUser && !sidebarOpen && userHasRole(currentUser, 'dispatcher') && !userHasRole(currentUser, 'admin') && !userHasRole(currentUser, 'driver') && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-11 w-11 min-h-[44px] min-w-[44px] p-0 touch-manipulation" aria-label="Open header menu">
                  <MoreVertical className="w-5 h-5 text-slate-500 dark:text-slate-400 dark:text-slate-500" />
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
          )}
        </div>

        {/* Centered Controls - drivers and admins only */}
        {currentUser && !sidebarOpen && (userHasRole(currentUser, 'driver') || userHasRole(currentUser, 'admin')) && (
          <div className="flex-1 flex items-center justify-center gap-2">
            {/* Menu */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-11 w-11 min-h-[44px] min-w-[44px] p-0 touch-manipulation" aria-label="Open header menu">
                  <MoreVertical className="w-5 h-5 text-slate-500 dark:text-slate-400 dark:text-slate-500" />
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

            {/* Status Toggle - drivers only */}
            {userHasRole(currentUser, 'driver') && (
              <div style={{ width: 'auto', overflow: 'hidden' }}>
                <DriverStatusToggle
                  currentUser={currentUser}
                  onStatusChange={onCurrentUserUpdate}
                />
              </div>
            )}

            {/* QR Code */}
            <button
              type="button"
              onClick={onInviteQRClick}
              aria-label="Generate invite QR code"
              className="h-11 w-11 min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-lg transition-colors hover:bg-slate-100 dark:bg-slate-800 dark:hover:bg-slate-700 touch-manipulation"
              title="Generate Invite QR Code">
              <QrCode className="w-6 h-6 text-slate-500 dark:text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:text-slate-300 dark:hover:text-slate-300" />
            </button>
          </div>
        )}

        {/* RIGHT: Battery + Avatar (+ QR for dispatchers) */}
        {currentUser && (
          <div className="flex items-center gap-2 flex-shrink-0">
            {/* QR Code for dispatchers — far right next to battery */}
            {!sidebarOpen && userHasRole(currentUser, 'dispatcher') && !userHasRole(currentUser, 'admin') && !userHasRole(currentUser, 'driver') && (
              <button
                type="button"
                onClick={onInviteQRClick}
                aria-label="Generate invite QR code"
                className="h-11 w-11 min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-lg transition-colors hover:bg-slate-100 dark:bg-slate-800 dark:hover:bg-slate-700 touch-manipulation"
                title="Generate Invite QR Code">
                <QrCode className="w-6 h-6 text-slate-500 dark:text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:text-slate-300 dark:hover:text-slate-300" />
              </button>
            )}
            <BatteryIndicator vertical={true} />
            <div
              role="button"
              tabIndex={0}
              onClick={handleAvatarClick}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  handleAvatarClick();
                }
              }}
              aria-label="Toggle immersive test mode"
              title="Immersive test mode"
              className={`relative w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 cursor-pointer select-none transition-shadow ${
                getUserAvatarGradient(currentUser)
              } ring-2 ring-offset-2 ring-offset-white dark:ring-offset-slate-900 ${
                immersiveTestActive
                  ? 'ring-emerald-500 shadow-[0_0_0_4px_rgba(16,185,129,0.25)]'
                  : 'ring-transparent'
              }`}>
              <span className="text-white font-bold text-xs pointer-events-none">
                {(getDriverDisplayName(currentUser) || 'U')?.charAt(0)}
              </span>
              {immersiveTestActive && (
                <span className="absolute -bottom-1 -right-1 w-3 h-3 rounded-full bg-emerald-500 border-2 border-white dark:border-slate-900 pointer-events-none" />
              )}
            </div>
          </div>
        )}
      </div>
      {/* Background GPS nudge — shown to drivers on Android after going on duty */}
      {userHasRole(currentUser, 'driver') && (
        <BackgroundLocationNudge isOnDuty={currentUser?.driver_status === 'on_duty'} />
      )}
    </header>
  );
}