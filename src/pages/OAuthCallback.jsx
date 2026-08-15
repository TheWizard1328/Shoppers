import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { initEncryption } from '@/components/utils/idbCrypto';
import { isCapacitorNativeApp } from '@/components/utils/locationProviders/capacitorRuntime';
import { Loader2 } from 'lucide-react';

/**
 * OAuthCallback — landing page for the /oauth-callback route.
 *
 * When a native APK user taps "Continue with Google/Microsoft/Apple", the
 * OAuth flow ends with a redirect to https://wizardworxx.com/oauth-callback
 * (a verified Android App Link). Android opens the app directly, and this
 * component extracts the access_token from the query string, sets it in the
 * SDK, and redirects to the dashboard.
 *
 * For the custom-scheme fallback (rxdeliver://auth), the token is handled by
 * the appUrlOpen listener in AuthContext — this component just shows a spinner.
 *
 * On web (non-native), the SDK's from_url param should have sent the user to
 * "/" directly, so we should never actually render here in a browser. But if
 * we do, we handle the token the same way.
 */
export default function OAuthCallback() {
  const navigate = useNavigate();
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;
    handled.current = true;

    const params = new URLSearchParams(window.location.search);
    const accessToken = params.get('access_token');
    const refreshToken = params.get('refresh_token');

    if (accessToken) {
      base44.auth.setToken(accessToken);
      if (refreshToken) {
        try { base44.auth.setRefreshToken?.(refreshToken); } catch {}
      }

      initEncryption(accessToken).catch((e) =>
        console.error('[OAuthCallback] IDB encryption init failed:', e)
      );

      // Full reload to ensure all SDK state is fresh
      setTimeout(() => { window.location.href = '/'; }, 200);
    } else {
      // No token — redirect to login
      setTimeout(() => { window.location.href = '/login'; }, 200);
    }
  }, []);

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '100vh',
      gap: '12px'
    }}>
      <Loader2 className="w-8 h-8 animate-spin text-primary" />
      <p className="text-sm text-muted-foreground">Completing sign in…</p>
    </div>
  );
}
