import React, { useMemo, useState, useEffect } from 'react';
import { ArrowLeft, MoreVertical, QrCode } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import SettingsMenu from './SettingsMenu';
import DriverStatusToggle from './DriverStatusToggle';
import BackgroundLocationNudge from './BackgroundLocationNudge';
import ProximityForegroundNudge from './ProximityForegroundNudge';
import BatteryIndicator from './BatteryIndicator';
import { userHasRole, isAppOwner } from '../utils/userRoles';
import { getDriverDisplayName } from '../utils/driverUtils';
import { useMobileNavigation } from '../navigation/MobileNavigationProvider';
import { getUserAvatarGradient } from './mobileHeaderUtils';
import { globalFilters } from '../utils/globalFilters';
import UpdateArrow from '../common/UpdateArrow';
import UpdateInfoBalloon from '../common/UpdateInfoBalloon';
import { clearUserCache } from '../utils/auth';
import { clearSettingsCache } from '../utils/userSettingsManager';
import { hardRefreshToNewBuild } from '@/components/utils/updateLoopGuard';

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
  hasWebUpdate,
  autoUpdatedNotice,
  onAutoUpdatedDismiss
}) {
  const { canGoBack: canGoBackInTab, goBack } = useMobileNavigation();

  // ── Immersive TEST MODE toggle badge ─────────────────────────────────────────
  // Reflects the immersive test-mode flag (broadcast by useImmersiveMode) so the
  // user badge visibly glows while test mode is engaged. Tapping the badge toggles
  // the flag. Available to all users on primary mobile devices (where MobileHeader
  // renders). Kept as a div badge (not a <button>) to preserve the original circular
  // avatar styling — tap gesture is wired via onClick + role/keyboard handlers.
  const [immersiveTestActive, setImmersiveTestActive] = useState(false);
  // Tracks a logo image that failed to load (expired/signed URL, CDN blip) so we
  // swap to the green Rx badge fallback instead of leaving a blank gap. Resets
  // whenever a new logo URL is supplied.
  const [logoFailed, setLogoFailed] = useState(false);
  // OWNER REQUEST (Nov 5 2026): "when the user clicks the app icon or the three
  // dots for the pop-up menu both actions will act as one button." One piece of
  // state drives BOTH triggers and BOTH role branches, so tapping the logo opens
  // the very same SettingsMenu the ellipsis does.
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  // Neither menu branch renders for a user with no dispatcher/driver/admin role,
  // so the logo keeps its old messaging shortcut in that case instead of being
  // a dead tap.
  const hasHeaderMenu = !!currentUser && !sidebarOpen && (
    (!userHasRole(currentUser, 'admin') && !userHasRole(currentUser, 'driver') && userHasRole(currentUser, 'dispatcher'))
    || userHasRole(currentUser, 'driver') || userHasRole(currentUser, 'admin')
  );
  const openHeaderMenuOrMessaging = () => {
    if (hasHeaderMenu) { setHeaderMenuOpen(true); return; }
    if (unreadMessageCount > 0) onMessagingClick?.();
  };
  useEffect(() => {setLogoFailed(false);}, [logo]);

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
      current_longitude: driverAppUser.current_longitude
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
  const shouldShow = isMobile !== undefined || isTabletPortrait !== undefined ?
  isMobile || isTabletPortrait :
  true;

  if (!shouldShow) return null;

  return (
    /* No safe-area-inset-top on the header — the .app-container already handles it.
       Adding it here too creates a double-padding dead bar at the top. */
    <header
      data-mobile-header
      className="mobile-header border-b sticky top-0 z-50 overflow-visible border-surface bg-surface">
      <div className="w-full min-h-[64px] flex items-center justify-between gap-2 px-4 py-1.5">
        {/* LEFT: Back button + Logo (+ Menu button for dispatchers) */}
        <div className="flex-1 min-w-0 flex items-center justify-start gap-1">
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
            className="flex items-center gap-2 min-w-0 shrink relative cursor-pointer"
            role="button"
            tabIndex={0}
            aria-label="Open header menu"
            aria-haspopup="menu"
            aria-expanded={headerMenuOpen}
            onClick={openHeaderMenuOrMessaging}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                openHeaderMenuOrMessaging();
              }
            }}>
            {logo && !logo.includes('placehold') && !logoFailed ?
            <img
              src={logo}
              alt="RxDeliver"
              className="rounded object-contain shrink-0"
              style={{ width: '64px', height: '64px', minWidth: '64px', minHeight: '64px', filter: 'var(--image-filter, none)' }}
              onError={() => setLogoFailed(true)} /> :


            <div className="w-11 h-11 rounded bg-emerald-700 flex items-center justify-center flex-shrink-0">
                <span className="text-white font-bold text-sm">Rx</span>
              </div>
            }
            {unreadMessageCount > 0 &&
            <button
              type="button"
              aria-label={`${unreadMessageCount} unread messages`}
              onClick={(e) => { e.stopPropagation(); onMessagingClick?.(); }}
              className="absolute z-10 bg-blue-500 appearance-none touch-manipulation"
              // OWNER REPORT Nov 5 2026: "The notification count badge on the app
              // icon on the mobile header has been elongated into an oval again."
              // The badge is a UA <button> inside a flex row, so ANY surviving
              // global/utility rule (button padding, min-width, aspect ratio,
              // font metrics on two glyphs) can stretch the box into a pill. The
              // geometry is now declared inline, which no stylesheet can override:
              // a hard 18x18 square, border-box so the white ring stays inside
              // those 18px, 1:1 aspect, overflow hidden and an explicit 9px glyph
              // so "9+" is narrower than the 14px inner width instead of pushing
              // the box sideways.
              style={{
                // OWNER REQUEST Nov 6 2026: "tighten it up by moving it slightly
                // down a few pixels and slightly to the right, closer to the
                // physical icon, without so much white space in between."
                // Was -4px/-4px (floating off the corner); now +1px/+1px so the
                // ring tucks into the icon's corner padding.
                top: '1px',
                left: '1px',
                width: '18px',
                height: '18px',
                minWidth: '18px',
                maxWidth: '18px',
                minHeight: '18px',
                maxHeight: '18px',
                aspectRatio: '1 / 1',
                boxSizing: 'border-box',
                borderRadius: '9999px',
                border: '2px solid #ffffff',
                padding: 0,
                margin: 0,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                overflow: 'hidden',
                flex: '0 0 auto',
                fontSize: unreadMessageCount > 9 ? '9px' : '10px',
                fontWeight: 700,
                letterSpacing: '-0.02em',
                lineHeight: 1,
                color: '#ffffff',
                textAlign: 'center',
                whiteSpace: 'nowrap',
              }}>
                {unreadMessageCount > 9 ? '9+' : unreadMessageCount}
              </button>
            }
          </div>

          {/* Menu button for dispatchers — left-aligned next to logo */}
          {currentUser && !sidebarOpen && userHasRole(currentUser, 'dispatcher') && !userHasRole(currentUser, 'admin') && !userHasRole(currentUser, 'driver') &&
          <DropdownMenu open={headerMenuOpen} onOpenChange={setHeaderMenuOpen}>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-11 w-11 min-h-[44px] min-w-[44px] p-0 touch-manipulation relative" aria-label="Open header menu" data-update-menu-btn>
                  <MoreVertical className="w-5 h-5 text-slate-500 dark:text-slate-400" />
                  {hasWebUpdate && <UpdateArrow type="web" />}
                </Button>
              </DropdownMenuTrigger>
              <SettingsMenu
              currentUser={currentUser}
              realUser={realUser}
              isAppOwner={isAppOwner(currentUser)}
              hasWebUpdate={hasWebUpdate}
              themePreference={themePreference}
              onThemeChange={onThemeChange}
              cities={cities}
              isMobile={true} />
            
            </DropdownMenu>
          }
        </div>

        {/* Centered Controls - drivers and admins only */}
        {currentUser && !sidebarOpen && (userHasRole(currentUser, 'driver') || userHasRole(currentUser, 'admin')) &&
        <div className="flex-none flex items-center justify-center gap-1.5">
            {/* Menu */}
            <DropdownMenu open={headerMenuOpen} onOpenChange={setHeaderMenuOpen}>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-11 w-11 min-h-[44px] min-w-[44px] p-0 touch-manipulation relative" aria-label="Open header menu" data-update-menu-btn>
                  <MoreVertical className="w-5 h-5 text-slate-500 dark:text-slate-400" />
                  {hasWebUpdate && <UpdateArrow type="web" />}
                </Button>
              </DropdownMenuTrigger>
              <SettingsMenu
              currentUser={currentUser}
              realUser={realUser}
              isAppOwner={isAppOwner(currentUser)}
              hasWebUpdate={hasWebUpdate}
              themePreference={themePreference}
              onThemeChange={onThemeChange}
              cities={cities}
              isMobile={true} />
            
            </DropdownMenu>

            {/* Status Toggle - drivers only */}
            {userHasRole(currentUser, 'driver') &&
          <div style={{ width: 'auto', overflow: 'hidden' }}>
                <DriverStatusToggle
              currentUser={currentUser}
              onStatusChange={onCurrentUserUpdate} />
            
              </div>
          }

            {/* QR Code */}
            <button
            type="button"
            onClick={onInviteQRClick}
            aria-label="Generate invite QR code"
            className="h-11 w-11 min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-lg transition-colors hover:bg-slate-100 dark:bg-slate-800 dark:hover:bg-slate-700 touch-manipulation"
            title="Generate Invite QR Code">
              <QrCode className="w-6 h-6 text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300" />
            </button>
          </div>
        }

        {/* RIGHT: Battery + Avatar (+ QR for dispatchers) */}
        {currentUser &&
        <div className="flex-1 min-w-0 flex items-center justify-end gap-2">
            {/* QR Code for dispatchers — far right next to battery */}
            {!sidebarOpen && userHasRole(currentUser, 'dispatcher') && !userHasRole(currentUser, 'admin') && !userHasRole(currentUser, 'driver') &&
          <button
            type="button"
            onClick={onInviteQRClick}
            aria-label="Generate invite QR code"
            className="h-11 w-11 min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-lg transition-colors hover:bg-slate-100 dark:bg-slate-800 dark:hover:bg-slate-700 touch-manipulation"
            title="Generate Invite QR Code">
                <QrCode className="w-6 h-6 text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300" />
              </button>
          }
            <BatteryIndicator vertical={true} />
            <div
            onClick={handleAvatarClick}
            aria-label="Toggle immersive test mode"
            title="Immersive test mode"
            className={`relative w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 cursor-pointer select-none transition-shadow ${
            getUserAvatarGradient(currentUser)} ring-2 ring-offset-2 ring-offset-white dark:ring-offset-slate-900 ${

            immersiveTestActive ?
            'ring-emerald-500 shadow-[0_0_0_4px_rgba(16,185,129,0.25)]' :
            'ring-transparent'}`
            }>
              <span className="text-white font-bold text-xs pointer-events-none">
                {(getDriverDisplayName(currentUser) || 'U')?.charAt(0)}
              </span>
              {immersiveTestActive &&
            <span className="absolute -bottom-1 -right-1 w-3 h-3 rounded-full bg-emerald-500 border-2 border-white dark:border-slate-900 pointer-events-none" />
            }
            </div>
          </div>
        }
      </div>
      {/* Web-update info balloon — expands from the menu button the moment
          the green web UpdateArrow appears. Tapping it performs the full app
          refresh (cache clear + reload), which is what picks up a web build. */}
      <UpdateInfoBalloon
        active={!!hasWebUpdate || !!autoUpdatedNotice}
        // "Just updated automatically" notice stays on screen until acknowledged
        persistent={!hasWebUpdate && !!autoUpdatedNotice}
        anchorSelector="[data-update-menu-btn]"
        direction="down"
        accent="#10b981"
        icon={hasWebUpdate ? "⬆️" : "✅"}
        title={hasWebUpdate ? "Update available" : "Update installed"}
        message={hasWebUpdate
          ? "A new version of the app is ready. Tap to refresh and pick it up."
          : "Your app was just updated automatically to the latest version."}
        cta={hasWebUpdate ? "Tap to update" : "Got it"}
        onClick={async () => {
          if (hasWebUpdate) {
            try {
              clearUserCache();
              clearSettingsCache();
            } catch (_) { /* silent fail — reload still picks up the build */ }
            hardRefreshToNewBuild('manual_update');
            return;
          }
          if (onAutoUpdatedDismiss) onAutoUpdatedDismiss();
        }}
      />
      {/* Background GPS nudge — shown to drivers on Android after going on duty */}
      {userHasRole(currentUser, 'driver') &&
      <BackgroundLocationNudge isOnDuty={currentUser?.driver_status === 'on_duty'} />
      }
      {/* Overlay-permission nudge for proximity auto-foreground (native APK drivers) */}
      {userHasRole(currentUser, 'driver') &&
      <ProximityForegroundNudge />
      }
    </header>);

}