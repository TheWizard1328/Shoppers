/**
 * Shared shell for every public auth page (Login, Forgot Password, Reset
 * Password, OAuth consent).
 *
 * OWNER FIX (Nov 15 2026 — APK screenshots, two rounds):
 * 1. Top: the logo was clipped by the notification panel because the shell used
 *    a bare min-h-screen with px-4 only.
 * 2. Bottom: padding alone was not enough. Making the shell its own scroll
 *    container (overflow-y-auto + m-auto) meant the card was cut at the bottom
 *    edge until the user scrolled INSIDE it, so the reserve never looked applied.
 *
 * Now the shell does not scroll itself: it is a normal block whose content flows
 * from the top with the device insets reserved as padding, and the DOCUMENT
 * scrolls when the card is taller than the screen. The bottom reserve is
 * `1.25rem + max(--native-safe-bottom, var(--app-inset-bottom))`, so it is
 * always at least 20px even if the APK reports a zero navigation-bar inset.
 *
 * --native-safe-top/bottom are injected by MainActivity when the APK runs
 * edge-to-edge (body.is-native-apk); env() is the web/PWA fallback.
 */
export default function AuthLayout({ icon: Icon, title, subtitle, footer, children }) {
  return (
    <div
      className="min-h-screen w-full bg-background px-4 flex flex-col"
      style={{
        // --portal-vh (index.css, w306): plain 100dvh everywhere except an iPhone
        // home-screen app, where it also covers the status-bar band iOS paints
        // but 100dvh does not count. The class above is the fallback.
        minHeight: "var(--portal-vh, 100dvh)",
        paddingTop: "calc(1.25rem + var(--app-inset-top))",
        paddingBottom: "calc(1.25rem + var(--app-inset-bottom))",
        paddingLeft: "calc(1rem + var(--app-inset-left))",
        paddingRight: "calc(1rem + var(--app-inset-right))"
      }}
    >
      {/* Top-aligned on phones (thumb reach + no clipped logo), vertically
          centred only once there is room for it. */}
      <div className="w-full max-w-md mx-auto sm:my-auto">
        <div className="text-center mb-8 sm:mb-10">
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
        <p className="text-center text-sm text-muted-foreground mt-6 mb-1">{footer}</p>
        }
      </div>
    </div>);

}
