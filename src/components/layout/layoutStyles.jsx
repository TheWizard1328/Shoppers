export const getLayoutStyles = ({ branding, sidebarWidth }) => `
          /* FORCE light mode color-scheme */
          html {
          }

          /* THEME VARIABLES MOVED (Nov 1 2026): the --bg-* / --text-* / --border-*
             token blocks and the shadcn token overrides now live in src/index.css
             so they survive environments that never apply this injected <style>
             (the Base44 editor). Only branding + geometry stay dynamic here. */

          html, body {
            font-size: 15px;
            margin: 0;
            padding: 0;
            height: 100%;
            min-height: 100vh;
            min-height: 100dvh;
            width: 100%;
            overflow: hidden;
            overscroll-behavior: none;
            background: var(--bg-white);
            color: var(--text-slate-900);
          }

          #root {
            height: 100%;
            min-height: 100vh;
            min-height: 100dvh;
            width: 100%;
            overflow: hidden;
          }

          :root {
            --sidebar-width: ${sidebarWidth}px;
            --safe-area-inset-top: env(safe-area-inset-top, 0px);
            --safe-area-inset-right: env(safe-area-inset-right, 0px);
            --safe-area-inset-bottom: env(safe-area-inset-bottom, 0px);
            --safe-area-inset-left: env(safe-area-inset-left, 0px);
            --bottom-nav-height: 0px;
            --actual-bottom-nav-height: 0px;
            --drawer-top: 0px;
            --drawer-bottom: 0px;
          }

          /* iOS STANDALONE HEIGHT LOCK (owner report Nov 15 2026): on an iPhone
             home-screen PWA the container intermittently resolved to 930px on an
             848px screen (iPhone = 848 viewport, probe measured innerH 848, lvh 896,
             env safe areas 48 top + 34 bottom). Whenever it did, main took the full
             848px, the bottom nav was pushed to y=851..896 and VANISHED below the
             fold, taking the bottom reserve with it - on every page, dashboard
             included. Pinning the container to the dynamic viewport height (and
             refusing to grow past it) makes the layout independent of whatever
             html/body/#root report on iOS. */
          .app-container { display:flex; flex-direction:row; height:100vh; height:100dvh; max-height:100vh; max-height:100dvh; min-height:0; width:100%; overflow:hidden; background:var(--bg-slate-50); padding-top:env(safe-area-inset-top, 0px); padding-bottom:env(safe-area-inset-bottom, 0px); padding-left:env(safe-area-inset-left, 0px); padding-right:env(safe-area-inset-right, 0px); box-sizing:border-box; position:relative; }
          /* Flex children must be allowed to shrink, or page content pushes the
             bottom nav out of the container instead of scrolling inside main. */
          .app-container .main-content-area { min-height:0 !important; }
          .app-container main { min-height:0 !important; }
          .app-container::before { content:''; position:absolute; top:0; left:0; right:0; height:env(safe-area-inset-top, 0px); background:var(--safe-area-bg); z-index:0; pointer-events:none; }
          .app-container::after { content:''; position:absolute; bottom:0; left:0; right:0; height:env(safe-area-inset-bottom, 0px); background:var(--safe-area-bg); z-index:0; pointer-events:none; }
          main { overscroll-behavior-y: contain !important; -webkit-overflow-scrolling: touch !important; max-height:100%; }
          .leaflet-container, .leaflet-tile-pane, .leaflet-map-pane { background: var(--bg-slate-50) !important; }
          .leaflet-container { z-index:1 !important; height:100% !important; width:100% !important; }
          .pb-safe { padding-bottom:max(1rem, env(safe-area-inset-bottom, 0px)); }
          .mb-safe { margin-bottom:env(safe-area-inset-bottom, 0px); }
          @supports (-webkit-touch-callout: none) { body, #root { height:-webkit-fill-available; overflow:hidden; } }
          /* ── Chrome modes (Sep 15, 2026) — class-driven from DeviceContext, NOT width media
             queries, so the chrome always matches the JS isMobile decision on every device:
             chrome-mobile  = Mode 1 & 2 (portrait phones/foldables/tablets) + phone landscape:
                              mobile header + bottom nav + drawer sidebar
             chrome-desktop = Mode 3 (landscape on wide devices — foldables/tablets,
                              landscape height >= 480px): persistent sidebar, no mobile chrome */
          .app-container.chrome-mobile .mobile-header { display:flex !important; position:sticky; top:0; z-index:51000 !important; background:var(--bg-white); border-bottom:1px solid var(--border-slate-200); }
          .app-container.chrome-mobile main { overflow-y:auto !important; overflow-x:hidden !important; flex:1; }
          .app-container.chrome-mobile .app-sidebar { position:fixed !important; left:0 !important; top:var(--drawer-top, calc(var(--native-safe-top, env(safe-area-inset-top, 0px)) + 64px)) !important; bottom:0 !important; padding-top:0 !important; padding-bottom:var(--drawer-bottom, 0px) !important; width:280px !important; max-width:80vw !important; z-index:50000 !important; transform:translateX(-100%) !important; transition:transform 0.3s cubic-bezier(0.4, 0, 0.2, 1) !important; background:var(--bg-white) !important; box-shadow:4px 0 12px var(--shadow-color) !important; flex-shrink:0 !important;  box-sizing:border-box !important; }
          /* Bottom nav must stay above the full-height drawer (owner Nov 16 2026) so it is
             visible and tappable while the drawer is open. */
          .app-container.chrome-mobile [data-mobile-bottom-nav],
          .app-container.tablet-portrait [data-mobile-bottom-nav] { position:relative; z-index:51000 !important; }
          .app-container.chrome-mobile .app-sidebar.sidebar-open { transform:translateX(0) !important; box-shadow:4px 0 12px var(--shadow-color) !important; }
          .app-container.chrome-mobile .main-content-area { width:100vw !important; flex:1 !important; display:flex !important; flex-direction:column !important; overflow:hidden !important; max-height:100vh !important; max-height:100dvh !important; }
          .app-container.chrome-desktop .mobile-header { display:none !important; }
          .app-container.chrome-desktop .app-sidebar { position:relative !important; transform:none !important; box-shadow:none !important; width:var(--sidebar-width) !important; min-width:200px !important; max-width:400px !important; flex:0 0 var(--sidebar-width) !important; transition:none !important; }
          .app-container.chrome-desktop .main-content-area { flex:1 1 auto !important; width:calc(100vw - var(--sidebar-width) - 1px) !important; min-width:400px !important; display:flex !important; flex-direction:column !important; overflow:hidden !important; max-height:100vh !important; max-height:100dvh !important; }
          /* tablet-portrait (Mode 2): overrides chrome-mobile with a roomier 320px drawer */
          .app-container.tablet-portrait .mobile-header { display:flex !important; position:sticky; top:0; z-index:51000 !important; background:var(--bg-white); border-bottom:1px solid var(--border-slate-200); }
          .app-container.tablet-portrait .app-sidebar { position:fixed !important; left:0 !important; top:var(--drawer-top, calc(var(--native-safe-top, env(safe-area-inset-top, 0px)) + 64px)) !important; bottom:0 !important; padding-top:0 !important; padding-bottom:var(--drawer-bottom, 0px) !important; width:320px !important; max-width:85vw !important; z-index:50000 !important; transform:translateX(-100%) !important; transition:transform 0.3s cubic-bezier(0.4, 0, 0.2, 1) !important; background:var(--bg-white) !important; box-shadow:4px 0 12px var(--shadow-color) !important; flex-shrink:0 !important;  box-sizing:border-box !important; }
          .app-container.tablet-portrait .app-sidebar.sidebar-open { transform:translateX(0) !important; box-shadow:4px 0 12px var(--shadow-color) !important; }
          .app-container.tablet-portrait .main-content-area { width:100vw !important; flex:1 !important; display:flex !important; flex-direction:column !important; overflow:hidden !important; max-height:100vh !important; max-height:100dvh !important; }
          .app-container.tablet-portrait main { overflow-y:auto !important; overflow-x:hidden !important; flex:1; }
          /* tablet landscape / wide-screen mobile: treat as desktop — sidebar always visible, no header */
          @media (orientation: landscape) and (hover: none) and (pointer: coarse) {
            .app-container.desktop-device .mobile-header { display:none !important; }
            .app-container.desktop-device .app-sidebar { position:relative !important; transform:none !important; box-shadow:none !important; width:var(--sidebar-width) !important; min-width:200px !important; max-width:400px !important; flex:0 0 var(--sidebar-width) !important; transition:none !important; }
            .app-container.desktop-device .main-content-area { flex:1 1 auto !important; width:calc(100vw - var(--sidebar-width) - 1px) !important; min-width:0 !important; }
          }
          .app-container.desktop-device .mobile-header { display:none !important; }
          .app-container.desktop-device .app-sidebar { position:relative !important; transform:none !important; box-shadow:none !important; width:var(--sidebar-width) !important; min-width:200px !important; max-width:400px !important; flex:0 0 var(--sidebar-width) !important; transition:none !important; }
          .app-container.desktop-device .main-content-area { flex:1 1 auto !important; width:calc(100vw - var(--sidebar-width) - 1px) !important; min-width:400px !important; display:flex !important; flex-direction:column !important; overflow:hidden !important; max-height:100vh !important; max-height:100dvh !important; }

          /* Overlay dims only the area between the header and the bottom nav (owner request
             Nov 15 2026) so the in-app chrome stays visible while the drawer is open. */
          /* FORM STACKING (owner report Nov 16 2026)
             Mobile chrome (header 51000, bottom nav 51000) is above the generic dialog layer,
             so the add/edit delivery form was covered by it whenever the mobile layout flag was
             not the one driving its inline z-[60000]. The chrome modes now force the form above
             the chrome by class, not by JS flag.
             The New Patient form opens ON TOP of that form (Add To Route > patient search >
             change address), so it must outrank the form itself everywhere, not just on phones. */
          .app-container.chrome-mobile [data-delivery-form-overlay="true"],
          .app-container.tablet-portrait [data-delivery-form-overlay="true"] { z-index: 60000 !important; }
          .patient-form-overlay { z-index: 65000 !important; }
          /* ADD TO ROUTE / EDIT FORM CENTERING (owner spec Nov 16 2026): the form overlay is
             fixed inset-0 centred, which centred it in the whole window and left it sitting
             right of centre over the map. When the sidebar is persistent (desktop chrome /
             desktop device) the overlay reserves the sidebar width on the left, so the form is
             centred in the MAP area only. Phones and tablet portrait keep full-width centring. */
          .app-container.chrome-desktop [data-delivery-form-overlay="true"],
          .app-container.desktop-device [data-delivery-form-overlay="true"] {
            padding-left: calc(var(--sidebar-width, 260px) + 1rem) !important;
          }
          /* PATIENT INFO SLIDE-OUT (owner spec Nov 16 2026, revised)
             Phones: the panel fills the screen edge to edge - top:0 / bottom:0, no white band
             above the header and none under the last card (the screenshot bands).
             Wider devices (tablet / desktop, incl. the APK): top padding removed, and the panel
             stops ABOVE the OS navigation bar so its blank background no longer paints behind it.
             Both modes pin top AND bottom explicitly - height:auto + inset is what keeps the box
             from drifting off the real viewport edge when the APK reports 100vh larger than the
             visible area. */
          /* OWNER FIX Nov 16 2026 (APK phone): bottom:0 let the panel's cards run under the phone's
             navigation bar. The panel now stops ABOVE the OS navigation bar on every width - the
             status-bar inset stays 0 at the top so there is still no white band there, and the
             bottom reserve is a single inset (env or the APK-injected value), never both. */
          .patient-history-panel {
            position:fixed !important; right:0; top:0 !important; height:auto !important; margin:0 !important;
            bottom:max(env(safe-area-inset-bottom, 0px), var(--native-safe-bottom, 0px)) !important;
            padding-top:0 !important; padding-bottom:0 !important; box-sizing:border-box;
          }
          body.is-native-apk .patient-history-panel {
            bottom:var(--native-safe-bottom, env(safe-area-inset-bottom, 0px)) !important;
          }
          body.is-native-apk .fixed.inset-0[data-state="open"].patient-history-backdrop { padding:0 !important; }
          .sidebar-overlay { position:fixed; left:0; right:0; top:var(--drawer-top, calc(var(--native-safe-top, env(safe-area-inset-top, 0px)) + 64px)); bottom:0; background:rgba(0,0,0,0.5); z-index:49998; animation:fadeIn 0.2s ease-out; }
          @keyframes fadeIn { from { opacity:0; } to { opacity:1; } }
          .custom-scrollbar::-webkit-scrollbar { height:8px; width:8px; }
          .custom-scrollbar::-webkit-scrollbar-track { background:transparent; }
          .custom-scrollbar::-webkit-scrollbar-thumb { background:rgba(0,0,0,0.2); border-radius:10px; }
          .custom-scrollbar::-webkit-scrollbar-thumb:hover { background:rgba(0,0,0,0.3); }
          .custom-scrollbar { scrollbar-width:thin; scrollbar-color:rgba(0,0,0,0.2) transparent; }
          :root { --primary: 15 23 42; --primary-foreground: 248 250 252; --secondary: 5 150 105; --secondary-foreground: 255 255 255; --accent: 239 246 255; --accent-foreground: 15 23 42; --muted: 248 250 252; --muted-foreground: 100 116 139; --border: 0 0 0; --input: 0 0 0; --ring: 5 150 105; }
          .border-yellow-400, .border-yellow-500, .border-yellow-600, input:focus, select:focus, textarea:focus, [data-state="open"] { border-color:black !important; }
          input:focus-visible, select:focus-visible, textarea:focus-visible, button:focus-visible { outline:2px solid black !important; outline-offset:2px; }
          ::placeholder, input::placeholder, textarea::placeholder, .text-muted, .text-muted-foreground, .text-slate-400, .text-slate-300, .text-gray-400, .text-gray-300, .text-slate-400 svg, .text-gray-400 svg { color:#64748b !important; opacity:1 !important; }
          /* FIX (Oct 2 2026): these two were leftover "FORCE light mode" rules from
             before dark mode existed. Being plain classes with !important, they
             ALWAYS beat Tailwind's non-!important dark: variant (e.g.
             bg-slate-50 dark:bg-slate-800) regardless of ANY class on <html> —
             the literal cause of the Square COD item rows staying white in
             dark mode no matter what theme fix landed upstream. Scoped to
             :not(.dark) so they still force the original light-mode intent
             but step aside once useAutoThemeSync puts 'dark' on <html>. */
          html:not(.dark) .text-slate-500 { color:#475569 !important; }
          .bg-yellow-100 { background-color:#fef3c7 !important; }
          .text-yellow-800 { color:#92400e !important; }
          .bg-yellow-400, .bg-yellow-500 { background-color:#f59e0b !important; color:#ffffff !important; }
          .text-yellow-600, .text-yellow-700 { color:#d97706 !important; }
          .border-yellow-300, .border-yellow-400 { border-color:#fbbf24 !important; }
          .stroke-yellow-500 { stroke:#f59e0b !important; }
          button:disabled, input:disabled, select:disabled, textarea:disabled { opacity:0.6 !important; color:#64748b !important; }
          button, [role="button"], nav, nav a, .select-none { -webkit-user-select:none; -moz-user-select:none; -ms-user-select:none; user-select:none; -webkit-touch-callout:none; }
          p:not(.select-none), span:not(.select-none), textarea, input { -webkit-user-select:text; -moz-user-select:text; -ms-user-select:text; user-select:text; }
          .safe-bottom { padding-bottom:max(0.5rem, env(safe-area-inset-bottom, 0px)); }
          /* Bottom sheets (vaul drawers: theme picker, city filter, bulk edit) are parked on the
             viewport bottom, so the app's bottom nav is NOT on screen while they are open.
             Reserving its height here left a large dead band under the sheet - and the APK
             added --native-safe-bottom on top of it, which is why the gap was twice as tall
             there. Each sheet pads its own footer for the OS safe area instead. */
          .fixed[role="dialog"][data-state="open"]:not([data-vaul-drawer]), .fixed[role="alertdialog"][data-state="open"]:not([data-vaul-drawer]) { padding-bottom:calc(var(--bottom-nav-height,0px) + var(--native-safe-bottom,0px)) !important; }
          /* EOD STATS PANEL (owner report Nov 18 2026, sixth attempt): the sheet rule above
             applies to EVERY [role="dialog"], so it also reserved the phone navigation bar
             height under the Route Summary card's Close button - an empty band exactly the
             height of the OS nav bar, which no Tailwind padding class could beat because the
             rule is !important. The stats card is a centred card, not a bottom sheet, so it
             opts out by attribute (higher specificity, declared after, still !important). */
          body .fixed[role="dialog"][data-state="open"][data-eod-stats-panel="true"] { padding-bottom: 8px !important; }
          [data-sonner-toaster][data-y-position="bottom"] { bottom:calc(var(--bottom-nav-height) + 0.5rem) !important; }

          /* ════════════════════════════════════════════════════════════
             APK SAFE-AREA INSETS (edge-to-edge mode)
             Only applies when body.is-native-apk is set (injected by
             MainActivity.java via WindowInsetsCompat). The web/PWA
             version never gets this class so these rules are no-ops there.
             --native-safe-top/bottom/left/right are also injected from native.
             ════════════════════════════════════════════════════════════ */

          /* Shadcn Dialog & AlertDialog overlays — the .fixed.inset-0 backdrop.
             Adding padding pushes the centered content away from the phone's
             status bar (top) and navigation bar (bottom). */
          body.is-native-apk .fixed.inset-0[role="dialog"][data-state="open"],
          body.is-native-apk .fixed.inset-0[role="alertdialog"][data-state="open"] {
            padding-top: var(--native-safe-top, env(safe-area-inset-top, 0px)) !important;
            padding-bottom: var(--native-safe-bottom, env(safe-area-inset-bottom, 0px)) !important;
            padding-left: var(--native-safe-left, env(safe-area-inset-left, 0px)) !important;
            padding-right: var(--native-safe-right, env(safe-area-inset-right, 0px)) !important;
          }

          /* Shadcn Drawer overlay + content */
          body.is-native-apk .fixed.inset-0[data-vaul-drawer-wrapper],
          body.is-native-apk .fixed.inset-0[class*="z-50"][data-state="open"]:not([role="dialog"]):not([role="alertdialog"]) {
            padding-bottom: var(--native-safe-bottom, env(safe-area-inset-bottom, 0px)) !important;
          }
          /* Bottom sheets in the edge-to-edge APK - owner spec Nov 15 2026: "increase the
             theme selection panel by the height of the phone navigation bar". With the sheet
             flush to the bottom edge (the w38 bottom-shift removal stays), the Cancel button
             sat behind the Android system nav bar. The APK path therefore grants the sheet the
             nav-bar height again, MINUS the 0.5rem (8px) the sheet footer already carries, so
             the total under the last row is exactly the phone navigation bar height - no more,
             no less. The web/PWA path is untouched and keeps the flush 8px footer. */
          body.is-native-apk [data-vaul-drawer-content],
          body.is-native-apk [role="dialog"][data-vaul-drawer] {
            padding-bottom: max(0px, calc(var(--native-safe-bottom, env(safe-area-inset-bottom, 0px)) - 0.5rem)) !important;
          }

          /* Shadcn Sheet overlay */
          body.is-native-apk .fixed.inset-0[data-state="open"]:not([role="dialog"]):not([role="alertdialog"]) {
            padding-top: var(--native-safe-top, env(safe-area-inset-top, 0px)) !important;
            padding-bottom: var(--native-safe-bottom, env(safe-area-inset-bottom, 0px)) !important;
          }

          /* Toast notifications pinned to top — push down past status bar */
          body.is-native-apk [data-sonner-toaster][data-y-position="top"] {
            top: var(--native-safe-top, env(safe-area-inset-top, 0px)) !important;
          }
          body.is-native-apk [data-sonner-toaster][data-y-position="bottom"] {
            bottom: calc(var(--native-safe-bottom, env(safe-area-inset-bottom, 0px)) + var(--bottom-nav-height, 0px) + 0.5rem) !important;
          }

          /* Custom full-screen overlays (fixed inset-0) — generic catch-all
             for non-Shadcn overlays like BarcodeOverlay, DeliveryCameraOverlay,
             SmartBarcodeScanner, etc. that use their own fixed inset-0 divs. */
          body.is-native-apk .fixed.inset-0:not([role="dialog"]):not([role="alertdialog"]):not([data-state]) {
            padding-top: var(--native-safe-top, env(safe-area-inset-top, 0px)) !important;
            padding-bottom: var(--native-safe-bottom, env(safe-area-inset-bottom, 0px)) !important;
          }

          /* Full-screen panels that should fill the entire screen (camera,
             scanner) — these need safe-area padding on their inner content,
             not on the overlay itself which should stay full-bleed. */
          body.is-native-apk .fixed.inset-0.bg-black:not([role="dialog"]):not([role="alertdialog"]) {
            padding-top: var(--native-safe-top, env(safe-area-inset-top, 0px)) !important;
            padding-bottom: var(--native-safe-bottom, env(safe-area-inset-bottom, 0px)) !important;
          }

          /* Generic fixed elements pinned to top: 0 — push down by status bar */
          body.is-native-apk .fixed.top-0:not(.inset-0):not(.patient-history-panel) {
            top: var(--native-safe-top, env(safe-area-inset-top, 0px)) !important;
          }

          /* Generic fixed elements pinned to bottom: 0 — push up by nav bar.
             Bottom sheets are excluded: lifting a sheet off the bottom edge left a strip of
             map showing under it, which read as a second gap below the panel. */
          body.is-native-apk .fixed.bottom-0:not(.inset-0):not([data-vaul-drawer]):not(.patient-history-panel) {
            bottom: var(--native-safe-bottom, env(safe-area-inset-bottom, 0px)) !important;
          }

          /* PatientHistoryPanel — owner spec Nov 16 2026: NO top offset any more. This rule used
             to push every .fixed.top-0.right-0 element down by the status-bar inset, which is
             the white band above the panel header in the APK. The patient panel is excluded
             and sits flush at the top (the panel header itself clears the status bar). */
          body.is-native-apk .fixed.top-0.right-0:not(.patient-history-panel) {
            top: var(--native-safe-top, env(safe-area-inset-top, 0px)) !important;
          }

          /* RouteManagementHeader dropdown — fixed bottom panel */
          body.is-native-apk .fixed.bottom-\[var\(--bottom-nav-height\)\] {
            bottom: calc(var(--bottom-nav-height, 0px) + var(--native-safe-bottom, env(safe-area-inset-bottom, 0px))) !important;
          }
          /* Hide bottom nav on desktop chrome only (Mode 3 / desktop browsers).
             Scoped to the chrome class — NOT a width media query. A width query
             wrongly hid the nav on wide PORTRAIT screens (foldable inner display,
             tablets) even though the JS correctly renders it there. */
          .app-container.chrome-desktop nav[data-mobile-bottom-nav] { display: none !important; }
          /* ── iPhone bottom band removal (owner report Nov 15 2026) ─────────────
             The container used to reserve the home-indicator inset as padding
             while the bottom nav sat above it, so the screen showed the bar and
             then a second empty band under it (probe: nav 769..814, padding 34px,
             screen 848).
             The container now reserves nothing and the nav itself owns the inset,
             so the bar is the last thing on the screen: flat to the edge on
             iPhone (0px, owner call) and the full system inset on Android, which
             is edge-to-edge and would otherwise have its buttons under the
             phone's own navigation bar.
             The nav stays IN FLOW. An earlier attempt made it position:fixed and
             overlaid the map, which broke the dashboard FAB stack and stop-card
             offsets, so flow layout is kept and --bottom-nav-height stays 0px. */
          .app-container.chrome-mobile, .app-container.tablet-portrait { padding-bottom:0 !important; }
          .app-container.chrome-desktop { padding-bottom:env(safe-area-inset-bottom, 0px); }
          .app-container.chrome-mobile nav[data-mobile-bottom-nav],
          .app-container.tablet-portrait nav[data-mobile-bottom-nav] {
            padding-bottom:env(safe-area-inset-bottom, 0px) !important;
            background:var(--bg-white) !important;
            box-sizing:border-box !important;
          }
          /* iPhone / iPad only (WebKit-on-iOS): no reserved band at all. */
          @supports (-webkit-touch-callout: none) {
            .app-container.chrome-mobile nav[data-mobile-bottom-nav],
            .app-container.tablet-portrait nav[data-mobile-bottom-nav] {
              padding-bottom:0px !important;
            }
          }
          .app-container.chrome-desktop { --bottom-nav-height: 0px; }
          html:not(.dark) .bg-slate-50 { background-color:#f8fafc !important; }
          .text-xs, .text-sm { color:inherit; }
          [role="option"][aria-selected="true"], [role="option"][data-selected="true"], [cmdk-item][data-selected="true"], [role="option"][aria-selected="true"] span, [role="option"][data-selected="true"] span, [cmdk-item][data-selected="true"] span { color:#000000 !important; }
          .store-color-0 { color: #3b82f6; }
          .store-color-1 { color: #ef4444; }
          .store-color-2 { color: #10b981; }
          .store-color-3 { color: #f59e0b; }
          .store-color-4 { color: #8b5cf6; }
          .store-color-5 { color: #ec4899; }
          .store-color-6 { color: #14b8a6; }
          .store-color-7 { color: #f97316; }
          .store-color-8 { color: #6366f1; }
          .store-color-9 { color: #84cc16; }
          .store-color-10 { color: #06b6d4; }
          .store-color-11 { color: #a855f7; }
      `;