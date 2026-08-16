import { useEffect, useRef, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { initEncryption } from '@/components/utils/idbCrypto';
import { Loader2, Smartphone } from 'lucide-react';

/**
 * OAuthCallback — landing page for the /oauth-callback route.
 *
 * Two very different flows land here, distinguished by the `native` query
 * param:
 *
 * 1. Web / PWA login (no `native` param): Base44's OAuth broker redirects
 *    here with access_token in the query string. We store the token and
 *    go to "/" as normal.
 *
 * 2. Native APK login (`native=1`): the user tapped a social login button
 *    INSIDE the Capacitor app. Capacitor's WebView can't load Google's
 *    OAuth pages directly (blocked as an embedded user-agent), so it
 *    hands off to external Chrome — a completely separate browser
 *    context from our app's WebView. Base44's OAuth broker only accepts
 *    http(s) redirect targets (a custom scheme like rxdeliver://auth
 *    passed directly as from_url gets silently dropped, falling back to
 *    "/" — confirmed by testing), so we send it here instead, tagged
 *    ?native=1. Once we land here (still inside external Chrome, with a
 *    valid access_token), THIS PAGE — not Base44's server — performs the
 *    final hop to rxdeliver://auth?access_token=... Chrome honors
 *    navigation to a custom scheme from an ordinary page load, and
 *    Android routes it to our app via the AndroidManifest intent-filter.
 *
 *    Chrome sometimes requires a real user gesture (tap) before it will
 *    follow a custom-scheme redirect — an automatic redirect right after
 *    page load can get silently swallowed. So we attempt it automatically
 *    AND show a "Return to RxDeliver App" button as a guaranteed-to-work
 *    fallback.
 */
export default function OAuthCallback() {
  const handled = useRef(false);
  const [deepLink, setDeepLink] = useState(null);
  const [status, setStatus] = useState('Completing sign in…');

  useEffect(() => {
    if (handled.current) return;
    handled.current = true;

    const params = new URLSearchParams(window.location.search);
    const accessToken = params.get('access_token');
    const refreshToken = params.get('refresh_token');
    const isNative = window.location.pathname.includes('/native-oauth-callback');

    if (!accessToken) {
      // Fallback: app-params.js may have already extracted and stored the token.
      // If we're on the native callback path, check localStorage as a last resort.
      if (isNative) {
        const storedToken = localStorage.getItem('base44_access_token');
        if (storedToken) {
          // Token was stripped by app-params — use it for the deep link
          const linkParams = new URLSearchParams({ access_token: storedToken });
          const storedRefresh = localStorage.getItem('base44_refresh_token');
          if (storedRefresh) linkParams.set('refresh_token', storedRefresh);
          const link = `rxdeliver://auth?${linkParams.toString()}`;
          setDeepLink(link);
          setStatus('Signed in! Returning to the app…');
          window.location.href = link;
          return;
        }
        // Clear any token that app-params may have stored — it belongs to the app, not the browser
        localStorage.removeItem('base44_access_token');
        localStorage.removeItem('base44_refresh_token');
      }
      setTimeout(() => { window.location.href = '/login'; }, 200);
      return;
    }

    if (isNative) {
      // Hand off to the native app via custom scheme — do NOT touch this
      // browser tab's own auth state, this token belongs to the app.
      const linkParams = new URLSearchParams({ access_token: accessToken });
      if (refreshToken) linkParams.set('refresh_token', refreshToken);
      const link = `rxdeliver://auth?${linkParams.toString()}`;
      setDeepLink(link);
      setStatus('Signed in! Returning to the app…');

      // Best-effort automatic hand-off. May be silently blocked by Chrome
      // without a user gesture — the visible button below always works.
      window.location.href = link;
      return;
    }

    // Normal web/PWA flow
    base44.auth.setToken(accessToken);
    if (refreshToken) {
      try { base44.auth.setRefreshToken?.(refreshToken); } catch {}
    }
    initEncryption(accessToken).catch((e) =>
      console.error('[OAuthCallback] IDB encryption init failed:', e)
    );
    setTimeout(() => { window.location.href = '/'; }, 200);
  }, []);

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '100vh',
      gap: '16px',
      padding: '24px',
      textAlign: 'center'
    }}>
      {deepLink ? (
        <>
          <Smartphone className="w-10 h-10 text-primary" />
          <p className="text-sm text-muted-foreground">{status}</p>
          <a
            href={deepLink}
            style={{
              display: 'inline-block',
              padding: '12px 24px',
              borderRadius: '8px',
              background: '#2563EB',
              color: '#fff',
              fontWeight: 600,
              textDecoration: 'none',
              fontSize: '15px'
            }}
          >
            Return to RxDeliver App
          </a>
          <p className="text-xs text-muted-foreground" style={{ maxWidth: '280px' }}>
            Didn't automatically switch back? Tap the button above.
          </p>
        </>
      ) : (
        <>
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">{status}</p>
        </>
      )}
    </div>
  );
}
