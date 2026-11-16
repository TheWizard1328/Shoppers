const APP_LOGO_URL = 'https://placehold.co/200x200?text=Logo';

/**
 * Shared shell for every public auth page (Login, Forgot Password, Reset
 * Password, OAuth consent).
 *
 * OWNER FIX (Nov 15 2026 — APK screenshot): the shell used a bare `min-h-screen`
 * with px-4 only, so inside the native APK the logo was clipped by the status
 * bar and the card ran under the Android navigation bar. It now reserves the
 * device safe areas exactly like the Patient Portal login does
 * (--native-safe-top / --native-safe-bottom, falling back to env()), sizes to
 * 100dvh so the WebView's shrinking viewport is respected, and scrolls instead
 * of clipping when the content is taller than the screen.
 */
export default function AuthLayout({ icon: Icon, title, subtitle, footer, children }) {
  return (
    <div
      className="min-h-screen w-full bg-background px-4 flex overflow-y-auto overscroll-contain"
      style={{
        // dvh where supported (APK / modern Chrome); the class above is the fallback.
        minHeight: "100dvh",
        paddingTop: "calc(1rem + var(--native-safe-top, env(safe-area-inset-top, 0px)))",
        paddingBottom: "calc(1rem + var(--native-safe-bottom, env(safe-area-inset-bottom, 0px)))",
        paddingLeft: "calc(1rem + env(safe-area-inset-left, 0px))",
        paddingRight: "calc(1rem + env(safe-area-inset-right, 0px))"
      }}>
      
      {/* m-auto (not the parent's justify-center) keeps the card centred when it
           fits and still lets the top of the page scroll into view when it does
           not — the old flex centring pushed the logo off-screen on short phones. */}
      <div className="w-full max-w-md m-auto">
        <div className="text-center sm:mb-10 mb-8">
          <div className="inline-flex items-center justify-center mb-4">
            <img src="https://media.base44.com/images/public/68570f3cd01bfa2d2408a9d6/0aeae1e24_renametoicon-192.png" alt="RxDeliver" className="w-16 h-16 object-contain rounded-2xl" />
          </div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-foreground">{title}</h1>
          {subtitle && <p className="text-muted-foreground mt-2 text-sm sm:text-base">{subtitle}</p>}
        </div>
        <div className="bg-card rounded-2xl shadow-sm border border-border p-6 sm:p-8">
          {children}
        </div>
        {footer &&
        <p className="text-center text-sm text-muted-foreground mt-6">{footer}</p>
        }
      </div>
    </div>);

}