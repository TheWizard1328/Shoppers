import React, { createContext, useState, useContext, useEffect, useRef } from 'react';
import { base44 } from '@/api/base44Client';
import { appParams } from '@/lib/app-params';
import { createAxiosClient } from '@base44/sdk/dist/utils/axios-client';
import { initEncryption, destroyKey } from '@/components/utils/idbCrypto';
import { isCapacitorNativeApp } from '@/components/utils/locationProviders/capacitorRuntime';

const AuthContext = createContext();

const getAppReturnUrl = () => `${window.location.origin}${window.location.pathname}${window.location.search}${window.location.hash}`;

// Deep link scheme for OAuth callback in native apps
const NATIVE_AUTH_SCHEME = 'rxdeliver://auth';

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoadingAuth, setIsLoadingAuth] = useState(true);
  const [isLoadingPublicSettings, setIsLoadingPublicSettings] = useState(true);
  const [authError, setAuthError] = useState(null);
  const [appPublicSettings, setAppPublicSettings] = useState(null); // Contains only { id, public_settings }
  const deepLinkHandledRef = useRef(false);

  useEffect(() => {
    checkAppState();
    setupDeepLinkHandler();
  }, []);

  // ─── Native OAuth deep link handler ─────────────────────────────
  // When running inside the Capacitor APK, OAuth providers redirect back
  // via rxdeliver://auth?access_token=... The AndroidManifest has an
  // intent filter for this scheme. We listen for appUrlOpen events
  // (app in background) and check getLaunchUrl (cold start).
  const setupDeepLinkHandler = async () => {
    if (!isCapacitorNativeApp()) return;

    try {
      const { App } = await import('@capacitor/app');

      // Handle cold-start deep links (app was killed, re-opened via intent)
      try {
        const launchResult = await App.getLaunchUrl();
        if (launchResult?.url) {
          handleDeepLink(launchResult.url);
        }
      } catch (e) {
        // getLaunchUrl may fail if no launch URL — non-fatal
      }

      // Handle warm deep links (app in background, receives new intent)
      App.addListener('appUrlOpen', ({ url }) => {
        handleDeepLink(url);
      });
    } catch (e) {
      console.warn('[Auth] Failed to set up deep link handler:', e?.message || e);
    }
  };

  const handleDeepLink = (url) => {
    if (!url || !url.startsWith('rxdeliver://') || deepLinkHandledRef.current) return;

    deepLinkHandledRef.current = true;
    console.log('[Auth] Received deep link callback:', url);

    try {
      const urlObj = new URL(url);
      const accessToken = urlObj.searchParams.get('access_token');
      const isNewUser = urlObj.searchParams.get('is_new_user');

      if (accessToken) {
        // Set the token in the SDK (localStorage + axios headers)
        base44.auth.setToken(accessToken);

        // Initialize IDB encryption with the new token
        initEncryption(accessToken).catch((e) =>
          console.error('[Auth] IDB encryption init failed after deep link:', e)
        );

        console.log('[Auth] Token set from deep link, redirecting to dashboard...');

        // Navigate to the dashboard — use a full reload to ensure
        // all SDK state (axios headers, app-params, etc.) is fresh
        setTimeout(() => {
          window.location.href = '/';
        }, 100);
      } else {
        // No token in the deep link — might be a logout callback or error
        console.warn('[Auth] Deep link had no access_token:', url);
        deepLinkHandledRef.current = false;
      }
    } catch (e) {
      console.error('[Auth] Failed to process deep link:', e);
      deepLinkHandledRef.current = false;
    }
  };

  const checkAppState = async () => {
    try {
      setIsLoadingPublicSettings(true);
      setAuthError(null);
      
      // First, check app public settings (with token if available)
      // This will tell us if auth is required, user not registered, etc.
      const appClient = createAxiosClient({
        baseURL: `${appParams.serverUrl}/api/apps/public`,
        headers: {
          'X-App-Id': appParams.appId
        },
        token: appParams.token, // Include token if available
        interceptResponses: true
      });
      
      try {
        const publicSettings = await appClient.get(`/prod/public-settings/by-id/${appParams.appId}`);
        setAppPublicSettings(publicSettings);
        
        // If we got the app public settings successfully, check if user is authenticated
        if (appParams.token) {
          await checkUserAuth();
        } else {
          setIsLoadingAuth(false);
          setIsAuthenticated(false);
        }
        setIsLoadingPublicSettings(false);
      } catch (appError) {
        console.error('App state check failed:', appError);
        
        // Handle app-level errors
        if (appError.status === 403 && appError.data?.extra_data?.reason) {
          const reason = appError.data.extra_data.reason;
          if (reason === 'auth_required') {
            setAuthError({
              type: 'auth_required',
              message: 'Authentication required'
            });
          } else if (reason === 'user_not_registered') {
            setAuthError({
              type: 'user_not_registered',
              message: 'User not registered for this app'
            });
          } else {
            setAuthError({
              type: reason,
              message: appError.message
            });
          }
        } else {
          setAuthError({
            type: 'unknown',
            message: appError.message || 'Failed to load app'
          });
        }
        setIsLoadingPublicSettings(false);
        setIsLoadingAuth(false);
      }
    } catch (error) {
      console.error('Unexpected error:', error);
      setAuthError({
        type: 'unknown',
        message: error.message || 'An unexpected error occurred'
      });
      setIsLoadingPublicSettings(false);
      setIsLoadingAuth(false);
    }
  };

  const checkUserAuth = async () => {
    try {
      // Now check if the user is authenticated
      setIsLoadingAuth(true);
      const currentUser = await base44.auth.me();
      setUser(currentUser);
      setIsAuthenticated(true);
      setIsLoadingAuth(false);

      // Initialize IDB encryption with the auth token
      const token = appParams.token || localStorage.getItem('base44_access_token');
      if (token) {
        initEncryption(token).catch((e) => console.error('[Auth] IDB encryption init failed:', e));
      }
    } catch (error) {
      console.error('User auth check failed:', error);
      setIsLoadingAuth(false);
      setIsAuthenticated(false);
      
      // If user auth fails, it might be an expired token
      if (error.status === 401 || error.status === 403) {
        setAuthError({
          type: 'auth_required',
          message: 'Authentication required'
        });
      }
    }
  };

  const logout = (shouldRedirect = true) => {
    setUser(null);
    setIsAuthenticated(false);
    
    // Destroy the encryption key — IDB data becomes unreadable
    destroyKey();
    
    if (isCapacitorNativeApp()) {
      // In the native app, OAuth happens in the system browser which owns
      // the session cookie. The WebView has no HTTP-only cookie to clear,
      // so we skip the server-side logout redirect and just clear locally.
      try {
        localStorage.removeItem('base44_access_token');
        localStorage.removeItem('token');
      } catch (e) {
        console.warn('[Auth] Failed to clear token from localStorage:', e);
      }
      // Reload to the app's internal login route (stays inside the WebView)
      if (shouldRedirect) {
        window.location.href = '/login';
      }
    } else if (shouldRedirect) {
      // Web: use the SDK's logout method which handles token cleanup and redirect
      base44.auth.logout(getAppReturnUrl());
    } else {
      // Just remove the token without redirect
      base44.auth.logout();
    }
  };

  const navigateToLogin = () => {
    if (isCapacitorNativeApp()) {
      // In the native app, redirect to the app's internal login page
      // (stays inside the WebView — no system browser)
      window.location.href = '/login';
    } else {
      // Web: use the SDK's redirectToLogin method
      base44.auth.redirectToLogin(getAppReturnUrl());
    }
  };

  return (
    <AuthContext.Provider value={{ 
      user, 
      isAuthenticated, 
      isLoadingAuth,
      isLoadingPublicSettings,
      authError,
      appPublicSettings,
      logout,
      navigateToLogin,
      checkAppState
    }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
