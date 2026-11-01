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
          }

          .app-container { display:flex; flex-direction:row; height:100%; min-height:100vh; min-height:100dvh; width:100%; overflow:hidden; background:var(--bg-slate-50); padding-top:env(safe-area-inset-top, 0px); padding-bottom:env(safe-area-inset-bottom, 0px); padding-left:env(safe-area-inset-left, 0px); padding-right:env(safe-area-inset-right, 0px); box-sizing:border-box; position:relative; }
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
          .app-container.chrome-mobile .mobile-header { display:flex !important; position:sticky; top:0; z-index:50 !important; background:var(--bg-white); border-bottom:1px solid var(--border-slate-200); }
          .app-container.chrome-mobile main { overflow-y:auto !important; overflow-x:hidden !important; flex:1; }
          .app-container.chrome-mobile .app-sidebar { position:fixed !important; left:0 !important; top:0 !important; bottom:0 !important; width:280px !important; max-width:80vw !important; z-index:50000 !important; transform:translateX(-100%) !important; transition:transform 0.3s cubic-bezier(0.4, 0, 0.2, 1) !important; background:var(--bg-white) !important; box-shadow:4px 0 12px var(--shadow-color) !important; flex-shrink:0 !important; padding-top:env(safe-area-inset-top, 0px) !important; padding-bottom:env(safe-area-inset-bottom, 0px) !important; box-sizing:border-box !important; }
          .app-container.chrome-mobile .app-sidebar.sidebar-open { transform:translateX(0) !important; box-shadow:4px 0 12px var(--shadow-color) !important; }
          .app-container.chrome-mobile .main-content-area { width:100vw !important; flex:1 !important; display:flex !important; flex-direction:column !important; overflow:hidden !important; max-height:100vh !important; max-height:100dvh !important; }
          .app-container.chrome-desktop .mobile-header { display:none !important; }
          .app-container.chrome-desktop .app-sidebar { position:relative !important; transform:none !important; box-shadow:none !important; width:var(--sidebar-width) !important; min-width:200px !important; max-width:400px !important; flex:0 0 var(--sidebar-width) !important; transition:none !important; }
          .app-container.chrome-desktop .main-content-area { flex:1 1 auto !important; width:calc(100vw - var(--sidebar-width) - 1px) !important; min-width:400px !important; display:flex !important; flex-direction:column !important; overflow:hidden !important; max-height:100vh !important; max-height:100dvh !important; }
          /* tablet-portrait (Mode 2): overrides chrome-mobile with a roomier 320px drawer */
          .app-container.tablet-portrait .mobile-header { display:flex !important; position:sticky; top:0; z-index:50 !important; background:var(--bg-white); border-bottom:1px solid var(--border-slate-200); }
          .app-container.tablet-portrait .app-sidebar { position:fixed !important; left:0 !important; top:0 !important; bottom:0 !important; width:320px !important; max-width:85vw !important; z-index:50000 !important; transform:translateX(-100%) !important; transition:transform 0.3s cubic-bezier(0.4, 0, 0.2, 1) !important; background:var(--bg-white) !important; box-shadow:4px 0 12px var(--shadow-color) !important; flex-shrink:0 !important; padding-top:env(safe-area-inset-top, 0px) !important; padding-bottom:env(safe-area-inset-bottom, 0px) !important; box-sizing:border-box !important; }
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

          .sidebar-overlay { position:fixed; inset:0; background:rgba(0,0,0,0.5); z-index:49999; animation:fadeIn 0.2s ease-out; }
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
          .fixed[role="dialog"][data-state="open"], .fixed[role="alertdialog"][data-state="open"] { padding-bottom:calc(var(--bottom-nav-height,0px) + var(--native-safe-bottom,0px)) !important; }
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
          body.is-native-apk [data-vaul-drawer-content],
          body.is-native-apk [role="dialog"][data-vaul-drawer] {
            padding-bottom: var(--native-safe-bottom, env(safe-area-inset-bottom, 0px)) !important;
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
          body.is-native-apk .fixed.top-0:not(.inset-0) {
            top: var(--native-safe-top, env(safe-area-inset-top, 0px)) !important;
          }

          /* Generic fixed elements pinned to bottom: 0 — push up by nav bar */
          body.is-native-apk .fixed.bottom-0:not(.inset-0) {
            bottom: var(--native-safe-bottom, env(safe-area-inset-bottom, 0px)) !important;
          }

          /* PatientHistoryPanel — slides in from right, needs top offset */
          body.is-native-apk .fixed.top-0.right-0 {
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