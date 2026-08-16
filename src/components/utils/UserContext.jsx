import React, { createContext, useContext, useState, useEffect } from 'react';
import { getEffectiveUser } from './auth';

const UserContext = createContext({
  currentUser: null,
  isLoadingUser: true,
  refreshUser: async () => {}
});

// Native APK dynamic environment routing — must match MainActivity.java's
// serverUrl values exactly (minus the trailing slash on preview).
const LIVE_HOST = 'wizardworxx.com';
const PREVIEW_HOST = 'preview--rx-deliver-2408a9d6.base44.app';

export const UserProvider = ({ children, initialUser = null }) => {
  const [currentUser, setCurrentUser] = useState(initialUser);
  const [isLoadingUser, setIsLoadingUser] = useState(!initialUser);

  const refreshUser = async () => {
    try {
      setIsLoadingUser(true);
      const user = await getEffectiveUser();
      setCurrentUser(user);
      return user;
    } catch (error) {
      console.error('❌ [UserContext] Failed to refresh user:', error);
      setCurrentUser(null);
      return null;
    } finally {
      setIsLoadingUser(false);
    }
  };

  useEffect(() => {
    // Only load user if not provided initially
    if (!initialUser) {
      refreshUser();
    } else {
      setIsLoadingUser(false);
    }
  }, [initialUser]);

  // Store environment preference for native APK routing
  // Owner/admin → preview, everyone else → live
  useEffect(() => {
    if (!currentUser) return;
    const setEnvPreferenceAndRedirect = async () => {
      try {
        const isNative = typeof window !== 'undefined' &&
          window.Capacitor?.isNativePlatform?.();
        if (!isNative) return;

        const { Preferences } = await import('@capacitor/preferences');
        const isAdmin = currentUser?.role === 'admin';
        const env = isAdmin ? 'preview' : 'live';
        const targetHost = isAdmin ? PREVIEW_HOST : LIVE_HOST;

        await Preferences.set({ key: 'rxdeliver_env', value: env });
        console.log(`📱 [Capacitor] Stored env preference: ${env}`);

        // CRITICAL: The stored preference only takes effect on the NEXT cold
        // start — MainActivity.java reads it BEFORE the WebView loads. Without
        // this check, an AppOwner who logs in while the WebView happens to be
        // pinned to the LIVE domain (e.g. first install, or after a role
        // change) stays on LIVE until they fully kill and reopen the app.
        // Instead, if the current domain doesn't match the target env,
        // redirect immediately by carrying the access token across origins —
        // the same hand-off mechanism the OAuth deep-link callback uses.
        // capacitor.config.json's allowNavigation explicitly permits this
        // cross-origin navigation inside the WebView.
        const currentHost = window.location.hostname;
        if (currentHost === targetHost) return; // Already on the correct domain

        // Avoid redirect loops — only attempt once per env value per app session
        const redirectFlagKey = 'rxdeliver_env_redirect_done';
        if (sessionStorage.getItem(redirectFlagKey) === env) return;
        sessionStorage.setItem(redirectFlagKey, env);

        const accessToken = localStorage.getItem('base44_access_token') || localStorage.getItem('token');
        if (!accessToken) return; // Nothing to carry over — skip rather than redirect unauthenticated

        console.log(`📱 [Capacitor] Env mismatch — redirecting ${currentHost} → ${targetHost} (${env})`);
        const params = new URLSearchParams({ access_token: accessToken });
        window.location.href = `https://${targetHost}/?${params.toString()}`;
      } catch (e) {
        // Not on native or Preferences not available — silently skip
      }
    };
    setEnvPreferenceAndRedirect();
  }, [currentUser?.id, currentUser?.role]);

  return (
    <UserContext.Provider value={{ currentUser, isLoadingUser, refreshUser }}>
      {children}
    </UserContext.Provider>
  );
};

export const useUser = () => {
  const context = useContext(UserContext);
  if (!context) {
    throw new Error('useUser must be used within a UserProvider');
  }
  return context;
};
