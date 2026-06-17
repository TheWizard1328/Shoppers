import React from 'react';
import ConnectionRecoveryBanner from './ConnectionRecoveryBanner';
import MobileOverlayBackHandler from './MobileOverlayBackHandler';
import PWAInstallPrompt from '../common/PWAInstallPrompt';
import CitySelectionPopup from '../cities/CitySelectionPopup';
import DeviceRegistration from '../devices/DeviceRegistration';
import MessagingPanel from '../messaging/MessagingPanel';
import InviteQRCodeModal from '../common/InviteQRCodeModal';
import ConflictManager from '../dashboard/ConflictManager';
import MessageNotificationBalloon from '../messaging/MessageNotificationBalloon';
import WebSocketDiagnosticsCard from './WebSocketDiagnosticsCard';
import { isAppOwner } from '../utils/userRoles';
import { useDevice } from '../utils/DeviceContext';

/**
 * GlobalOverlays
 * All floating modals/panels/banners extracted from Layout.jsx.
 * None of these affect the main layout structure.
 */
export default function GlobalOverlays({
  // device / layout isTabletPortrait,
  sidebarOpen, showMessaging, showInviteQRModal,
  showCitySelectionPopup, isFormOverlayOpen,
  deviceRegistered, setDeviceRegistered,
  showInitRetryHint,
  // data
  currentUser, cities, users, stores,
  initialConversation,
  unreadMessageCount,
  // handlers
  onRequestCloseOverlay,
  handleCitySelected,
  setShowMessaging,
  setInitialConversation,
  setUnreadMessageCount,
  setShowInviteQRModal,
  setSidebarOpen,
}) {
  const { isMobile, isTabletPortrait } = useDevice();
  return (
    <>
      <ConnectionRecoveryBanner />
      <MobileOverlayBackHandler isMobile={isMobile} isTabletPortrait={isTabletPortrait} isOverlayOpen={sidebarOpen || showMessaging || showInviteQRModal || showCitySelectionPopup || isFormOverlayOpen} onRequestCloseOverlay={() => {if (sidebarOpen) setSidebarOpen(false);if (showMessaging) {setShowMessaging(false);setInitialConversation(null);}if (showInviteQRModal) setShowInviteQRModal(false);if (isFormOverlayOpen) window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));}} />

      {/* PWA Install Prompt */}
      <PWAInstallPrompt />

      {showCitySelectionPopup && currentUser && cities && cities.length > 0 &&
      <CitySelectionPopup
        cities={cities}
        currentUser={currentUser}
        onCitySelected={handleCitySelected} />
      }

      {/* Device Registration - Shows existing devices or option to create new - ALL USERS */}
      {!showCitySelectionPopup && !deviceRegistered && currentUser &&
      <DeviceRegistration
        currentUser={currentUser}
        onDeviceRegistered={(device) => {
          console.log('✅ Device registered:', device);
          setDeviceRegistered(true);
          // Cache the registration to prevent re-prompting on refresh
          localStorage.setItem(`rxdeliver_device_registered_${device.device_identifier}`, 'true');
        }} />
      }

      {showMessaging &&
      <MessagingPanel
        currentUser={currentUser}
        users={users}
        onClose={() => {
          setShowMessaging(false);
          setInitialConversation(null);
        }}
        initialConversation={initialConversation}
        onUnreadCountChange={setUnreadMessageCount} />
      }

      {showInviteQRModal &&
      <InviteQRCodeModal
        isOpen={showInviteQRModal}
        onClose={() => setShowInviteQRModal(false)}
        currentUser={currentUser}
        stores={stores} />
      }

                  {/* Global Conflict Manager */}
                  <ConflictManager />
                  
                  {/* Message Notification Balloon */}
                               {currentUser && !showMessaging &&
      <MessageNotificationBalloon
        currentUser={currentUser}
        onOpenConversation={(conversationId, otherUserId, otherUserName) => {
          setInitialConversation({ conversationId, otherUserId, otherUserName });
          setShowMessaging(true);
          setUnreadMessageCount(0);
        }} />
      }
                               {/* WebSocket Diagnostics Card - App Owners only, non-primary devices */}
                               {isAppOwner(currentUser) &&
      <WebSocketDiagnosticsCard />
      }
    </>
  );
}