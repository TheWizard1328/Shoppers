import React, { createContext, useState, useContext, useEffect, useRef } from 'react';
import { restoreTokenFromBridge, shipBootDiags, recordBootDiag, clearTokenBridge } from '@/lib/authTokenBridge';
import { base44 } from '@/api/base44Client';
import { appParams } from '@/lib/app-params';
import { createAxiosClient } from '@base44/sdk/dist/utils/axios-client';
import { initEncryption, destroyKey, setEncryptionBypass } from '@/components/utils/idbCrypto';
import { isAppOwner } from '@/components/utils/userRoles';
import { isCapacitorNativeApp } from '@/components/utils/locationProviders/capacitorRuntime';

// Bounded timeout for platform API calls during boot. If the Base44 platform
// is degraded (the public-settings or auth.me endpoint hangs), the loader would
// spin forever on a cold reload. This resolves to a rejection after `ms` so the
// existing catch blocks release the loading gate (→ login redirect / error),
// instead of pinning the slate PageLoader indefinitely.
const _withTimeout = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    )
  ]);

// ── OFFLINE-FIRST AUTH (owner report Nov 12 2026) ───────────────────────────
// The app was unloadable for ~15 minutes on a weak link: checkAppState() and
// checkUserAuth() BOTH required a live platform call, so a timeout set an
// authError / isAuthenticated=false and the router bounced to the login screen
// even though the session and the whole offline database were intact on the
// device. The last good auth.me() user and public-settings snapshot are now
// cached, and a TRANSPORT failure (offline, timeout, network error, 5xx during a
// deploy) boots from that cache instead of failing. A real 401/403 still signs
// the user out, and the cache is cleared on logout.
const AUTH_SNAPSHOT_KEY = 'rxdeliver_auth_snapshot_v1';
const readAuthSnapshot = () => {
  try {
    const raw = localStorage.getItem(AUTH_SNAPSHOT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && parsed.user ? parsed : null;
  } catch { return null; }
};
const writeAuthSnapshot = (user, settings) => {
  try {
    if (!user) return;
    localStorage.setItem(AUTH_SNAPSHOT_KEY, JSON.stringify({ user, settings: settings || null, saved_at: Date.now() }));
  } catch { /* quota — the cache is an optimization, never fatal */ }
};
const clearAuthSnapshot = () => { try { localStorage.removeItem(AUTH_SNAPSHOT_KEY); } catch {} };
// True only for failures that say nothing about the session being valid:
// no HTTP status at all (offline / DNS / abort), a gateway 5xx during a deploy,
// or a timeout. A 401/403/404 is a real answer and must NOT be softened.
const isTransportFailure = (error) => {
  const status = Number(error?.status || error?.response?.status || 0);
  if (status >= 500 && status <= 599) return true;
  if (status >= 400) return false;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  const msg = String(error?.message || '').toLowerCase();
  return error?.code === 'ECONNABORTED'
    || msg.includes('timeout')
    || msg.includes('network')
    || msg.includes('failed to fetch')
    || msg.includes('load failed')
    || msg.includes('timed out');
};

const AuthContext = createContext();

const getAppReturnUrl = () =>  `${window.location.origin}${window.location.pathname}${window.location.search}${window.location.hash}`;

// Deep link target for OAuth callback in native apps.
// We use the custom scheme rxdeliver://auth because wizardworxx.com's
// assetlinks.json is controlled by the Base44 platform (lists their own
// package, not ours), so verified App Links can never resolve to our APK.
const NATIVE_AUTH_SCHEME = 'rxdeliver://auth';

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoadingAuth, setIsLoadingAuth] = useState(true);
  const [isLoadingPublicSettings, setIsLoadingPublicSettings] = useState(true);
  const [authError, setAuthError] = useState(null);
  const [appPublicSettings, setAppPublicSettings] = useState(null); // Contains only { id, public_settings }
  const deepLinkHandledRef = useRef(false);
  const publicSettingsRef = useRef(null);

  useEffect(() => {
    // PERF/UX (owner report Oct 9 2026: force close forced re-login): restore
    // the access token from the IDB bridge BEFORE the auth check — Android
    // WebView can evict localStorage (losing the session) while keeping
    // IndexedDB alive. No-op when the token is still present.
    restoreTokenFromBridge().finally(() => {
      checkAppState();
      setupDeepLinkHandler();
    });
  }, []);

  // After an offline-first boot, re-validate the moment the link comes back so
  // an expired session is caught then (not silently kept), and the cache is
  // refreshed with the live user.
  //
  // SILENT ON PURPOSE (owner report Nov 12 2026: "as soon as the data came back
  // the entire app rebooted instead of just continuing where it left off").
  // checkAppState() flips isLoadingPublicSettings/isLoadingAuth, which makes
  // ProtectedRoute swap the whole dashboard for a spinner — a full teardown and
  // re-boot of the map, cards and IDB reads. The reconnect path now refreshes
  // the user object in place with no loading gate, so the app keeps running and
  // the offline queue flushes underneath.
  useEffect(() => {
    const onOnline = () => {
      void refreshSessionSilently();
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
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
    if (!url) return;
    const isAuthDeepLink = url.startsWith('rxdeliver://');
    // APP-LINK CAPTURE (owner report Oct 25 2026): rxdeliver.wizardworxx.com's
    // assetlinks.json verifies this APK, so Android captures the broker's
    // https://.../oauth-callback redirect and hands it to the APK instead of
    // Chrome — the access_token rides IN THE CAPTURED URL. Previously only the
    // rxdeliver:// custom scheme was processed, so a captured https login
    // token was dropped and the driver bounced back to /login forever
    // (drivers on the new APK could not log in at all). Accept the https
    // callback URLs of BOTH hosts (old wizardworxx.com APKs still live during
    // the migration) and both callback paths.
    const _isHttpsAuthCallback = /^https:\/\/(www\.|rxdeliver\.)?wizardworxx\.com\/(native-)?oauth-callback/.test(url);
    if (!isAuthDeepLink && !_isHttpsAuthCallback) return;
    if (deepLinkHandledRef.current) return;

    deepLinkHandledRef.current = true;
    console.log('[Auth] Received deep link callback:', url);

    try {
      const urlObj = new URL(url);
      const accessToken = urlObj.searchParams.get('access_token');
      const refreshToken = urlObj.searchParams.get('refresh_token');
      const isNewUser = urlObj.searchParams.get('is_new_user');

      if (accessToken) {
        // Set the token in the SDK (localStorage + axios headers)
        base44.auth.setToken(accessToken);
        if (refreshToken) {
          try { base44.auth.setRefreshToken?.(refreshToken); } catch {}
        }

        // IDB encryption init deferred to checkUserAuth (which knows the user role)

        // Update native GPS POST headers with the fresh token so the
        // @capgo foreground service keeps authenticating after token rotation.
        if (isCapacitorNativeApp()) {
          import('@/components/utils/locationTracker').then(({ locationTracker }) => {
            locationTracker.updateNativePostHeaders?.().catch(() => {});
          }).catch(() => {});
        }

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

  // Safety net: if Base44 strips the path from from_url and redirects to
  // /?access_token=..., the PWA loads and app-params.js stores the token.
  // On mobile browsers, detect this and show a "Return to app" redirect.
  // This only triggers when: (1) not inside Capacitor, (2) access_token in URL,
  // (3) Android mobile browser, (4) path is / (Base44 stripped the path).
  useEffect(() => {
    if (isCapacitorNativeApp()) return; // Only for browser, not the WebView itself
    
    const url = new URL(window.location.href);
    const accessToken = url.searchParams.get('access_token');
    const isRootPath = url.pathname === '/';
    
    if (accessToken && isRootPath) {
      const isAndroid = /android/i.test(navigator.userAgent);
      const isMobile = /mobile|tablet/i.test(navigator.userAgent);
      
      if (isAndroid && isMobile) {
        // Don't strip the token — build the deep link from it
        const linkParams = new URLSearchParams({ access_token: accessToken });
        const refreshToken = url.searchParams.get('refresh_token');
        if (refreshToken) linkParams.set('refresh_token', refreshToken);
        const deepLink = `rxdeliver://auth?${linkParams.toString()}`;
        
        // Show a redirect page instead of loading the dashboard
        console.log('[Auth] Safety net: mobile browser with access_token at root, redirecting to app');
        window.location.replace(deepLink);
      }
    }
  }, []);

  // Re-validate the session WITHOUT touching any loading gate. Used on reconnect.
  const refreshSessionSilently = async () => {
    try {
      const me = await _withTimeout(base44.auth.me(), 10000, 'auth.me(silent)');
      if (me) {
        setUser(me);
        setIsAuthenticated(true);
        setAuthError(null);
        writeAuthSnapshot(me, publicSettingsRef.current);
      }
      console.warn('[Auth] Session re-validated on reconnect');
    } catch (error) {
      const status = Number(error?.status || error?.response?.status || 0);
      if (status === 401 || status === 403) {
        // A real rejection while online — the session is genuinely gone.
        clearAuthSnapshot();
        setUser(null);
        setIsAuthenticated(false);
        setAuthError({ type: 'auth_required', message: 'Authentication required' });
        return;
      }
      // Transport failure again: keep running on the cached session.
      console.warn('[Auth] Reconnect re-validation could not reach the server — staying on the cached session');
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
        const publicSettings = await _withTimeout(
          appClient.get(`/prod/public-settings/by-id/${appParams.appId}`),
          12000, 'public-settings'
        );
        setAppPublicSettings(publicSettings);
        publicSettingsRef.current = publicSettings;
        
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

        // Offline / deploy-window: boot from the cached session instead of
        // bouncing to login. A real 401/403 still falls through to authError.
        const snapshot = readAuthSnapshot();
        if (isTransportFailure(appError) && snapshot?.user) {
          console.warn('[Auth] Platform unreachable — booting from cached session (offline-first)');
          publicSettingsRef.current = snapshot.settings || null;
          setAppPublicSettings(snapshot.settings || null);
          setUser(snapshot.user);
          setIsAuthenticated(true);
          setAuthError(null);
          setIsLoadingAuth(false);
          setIsLoadingPublicSettings(false);
          return;
        }
        
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
      const currentUser = await _withTimeout(base44.auth.me(), 10000, 'auth.me');
      setUser(currentUser);
      setIsAuthenticated(true);
      writeAuthSnapshot(currentUser, publicSettingsRef.current);
      void shipBootDiags(); // ship any wipe-diag rows from earlier (possibly unauthenticated) boots
      setIsLoadingAuth(false);

      // Initialize IDB encryption — bypass for App Owner (Preview environment IDB conflicts)
      const token = appParams.token || localStorage.getItem('base44_access_token');
      if (token) {
        if (isAppOwner(currentUser)) {
          setEncryptionBypass(true);
        } else {
          initEncryption(token).catch((e) => console.error('[Auth] IDB encryption init failed:', e));
        }
        // Refresh native GPS POST headers on app startup in case the token
        // was refreshed while the app was killed (START_STICKY restart uses
        // the old persisted header until we call updateHeaders).
        if (isCapacitorNativeApp()) {
          import('@/components/utils/locationTracker').then(({ locationTracker }) => {
            locationTracker.updateNativePostHeaders?.().catch(() => {});
          }).catch(() => {});
        }
      }
    } catch (error) {
      console.error('User auth check failed:', error);

      // Offline-first: a transport failure is not a rejected session. Reuse the
      // cached user so the dashboard, offline DB and route keep working.
      const snapshot = readAuthSnapshot();
      if (isTransportFailure(error) && snapshot?.user) {
        console.warn('[Auth] auth.me unreachable — using cached session (offline-first)');
        setUser(snapshot.user);
        setIsAuthenticated(true);
        setAuthError(null);
        setIsLoadingAuth(false);
        void recordBootDiag({ auth_result: 'cached_offline', status: null, msg: 'auth.me unreachable; served cached session' });
        return;
      }

      setIsLoadingAuth(false);
      setIsAuthenticated(false);
      // AUTH-BOOT DIAG: the token (restored or live) was REJECTED server-side —
      // distinguishes "wipe cleared storage" from "session expired platform-side".
      void recordBootDiag({ auth_result: 'rejected', status: error?.status || null, msg: String(error?.message || error).slice(0, 120) });
      
      // If user auth fails, it might be an expired token
      if (error.status === 401 || error.status === 403) {
        setAuthError({
          type: 'auth_required',
          message: 'Authentication required'
        });
      }
    }
  };

  const logout = async (shouldRedirect = true) => {
    clearAuthSnapshot();
    setUser(null);
    setIsAuthenticated(false);
    
    // Clear breadcrumb trail cache to free memory
    import('@/components/utils/locationBreadcrumbService').then(({ clearAllBreadcrumbCaches }) => clearAllBreadcrumbCaches()).catch(() => {});
    // Destroy the encryption key — IDB data becomes unreadable
    destroyKey();

    // LOGOUT FIX (owner report Oct 23 2026: dispatcher logout briefly showed
    // the login page then bounced straight back into the app): the auth token
    // bridge mirrors the access token into IndexedDB (push service worker)
    // and boot RESTORES it whenever localStorage is empty. The SDK logout
    // clears localStorage and the server logout clears cookies — but the
    // bearer token stays server-valid and the bridge copy survived both, so
    // the post-logout reload silently re-authenticated. Clear the bridge
    // BEFORE the redirect fires so there is nothing to restore.
    try { await clearTokenBridge(); } catch { /* non-fatal — worst case restore hits a dead token */ }

    if (isCapacitorNativeApp()) {
      // In the native app, OAuth happens in the system browser which owns
      // the session cookie. The WebView has no HTTP-only cookie to clear,
      // so we skip the server-side logout redirect and just clear locally.
      try {
        localStorage.removeItem('base44_access_token');
        localStorage.removeItem('token');
        // Clear the env-redirect guard so the NEXT login (possibly a
        // different account, e.g. AppOwner vs a driver) can redirect to
        // the correct domain again instead of being skipped as a "loop".
        sessionStorage.removeItem('rxdeliver_env_redirect_done');
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