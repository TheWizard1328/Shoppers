export const getLayoutStyles = ({ branding, sidebarWidth }) => `
          /* FORCE light mode color-scheme */
          html {
          }

          :root {
            --bg-white: #ffffff;
            --bg-slate-50: #f8fafc;
            --bg-slate-100: #f1f5f9;
            --bg-slate-200: #e2e8f0;
            --text-slate-900: #0f172a;
            --text-slate-800: #1e293b;
            --text-slate-700: #334155;
            --text-slate-600: #475569;
            --text-slate-500: #64748b;
            --text-slate-400: #94a3b8;
            --border-slate-200: #e2e8f0;
            --border-slate-300: #cbd5e1;
            --shadow-color: rgba(0, 0, 0, 0.1);
            --image-filter: none;
            --menu-border: #000000;
            --primary-color: ${branding.primary_color};
            --secondary-color: ${branding.secondary_color};
            --accent-color: ${branding.accent_color};
          }

          html.dark-theme,
          html.dark-theme body {
            --bg-white: #0f172a;
            --bg-slate-50: #1e293b;
            --bg-slate-100: #334155;
            --bg-slate-200: #475569;
            --text-slate-900: #f8fafc;
            --text-slate-800: #f1f5f9;
            --text-slate-700: #e2e8f0;
            --text-slate-600: #cbd5e1;
            --text-slate-500: #94a3b8;
            --text-slate-400: #64748b;
            --border-slate-200: #cbd5e1;
            --border-slate-300: #94a3b8;
            --shadow-color: rgba(255, 255, 255, 0.1);
            --image-filter: invert(1) hue-rotate(180deg);
            --menu-border: #e2e8f0;
          }

          @media (prefers-color-scheme: dark) {
            html.auto-theme,
            html.auto-theme body {
              --bg-white: #0f172a;
              --bg-slate-50: #1e293b;
              --bg-slate-100: #334155;
              --bg-slate-200: #475569;
              --text-slate-900: #f8fafc;
              --text-slate-800: #f1f5f9;
              --text-slate-700: #e2e8f0;
              --text-slate-600: #cbd5e1;
              --text-slate-500: #94a3b8;
              --text-slate-400: #64748b;
              --border-slate-200: #cbd5e1;
              --border-slate-300: #94a3b8;
              --shadow-color: rgba(255, 255, 255, 0.1);
              --image-filter: invert(1) hue-rotate(180deg);
              --menu-border: #e2e8f0;
            }
          }

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
          }

          .app-container { display:flex; flex-direction:row; height:100%; min-height:100vh; min-height:100dvh; width:100%; overflow:hidden; background:var(--bg-slate-50); }
          main { overscroll-behavior-y: contain !important; -webkit-overflow-scrolling: touch !important; max-height:100%; }
          .leaflet-container, .leaflet-tile-pane, .leaflet-map-pane { background: var(--bg-slate-50) !important; }
          .leaflet-container { z-index:1 !important; height:100% !important; width:100% !important; }
          .pb-safe { padding-bottom:max(1rem, env(safe-area-inset-bottom, 0px)); }
          .mb-safe { margin-bottom:env(safe-area-inset-bottom, 0px); }
          @supports (-webkit-touch-callout: none) { body, #root { height:-webkit-fill-available; overflow:hidden; } }
          @media (max-width: 767px) {
            .app-container.mobile-device .mobile-header { display:flex !important; position:sticky; top:0; z-index:50 !important; background:var(--bg-white); border-bottom:1px solid var(--border-slate-200); }
            .app-container.mobile-device main { overflow-y:auto !important; overflow-x:hidden !important; flex:1; }
            .app-container.mobile-device .app-sidebar { position:fixed !important; left:0 !important; top:0 !important; bottom:0 !important; width:280px !important; max-width:80vw !important; z-index:50000 !important; transform:translateX(-100%) !important; transition:transform 0.3s cubic-bezier(0.4, 0, 0.2, 1) !important; background:var(--bg-white) !important; box-shadow:4px 0 12px var(--shadow-color) !important; flex-shrink:0 !important; }
            .app-container.mobile-device .app-sidebar.sidebar-open { transform:translateX(0) !important; box-shadow:4px 0 12px var(--shadow-color) !important; }
            .app-container.mobile-device .main-content-area { width:100vw !important; flex:1 !important; display:flex !important; flex-direction:column !important; overflow:hidden !important; max-height:100vh !important; max-height:100dvh !important; }
          }
          @media (min-width: 768px) {
            .app-container.mobile-device .mobile-header { display:none !important; }
            .app-container.mobile-device .app-sidebar { position:relative !important; transform:none !important; box-shadow:none !important; width:var(--sidebar-width) !important; min-width:200px !important; max-width:400px !important; flex:0 0 var(--sidebar-width) !important; transition:none !important; }
            .app-container.mobile-device .main-content-area { flex:1 1 auto !important; width:calc(100vw - var(--sidebar-width) - 1px) !important; min-width:400px !important; display:flex !important; flex-direction:column !important; overflow:hidden !important; max-height:100vh !important; max-height:100dvh !important; }
          }
          /* tablet-portrait: header shown, sidebar slides in as overlay (portrait only) */
          .app-container.tablet-portrait .mobile-header { display:flex !important; position:sticky; top:0; z-index:50 !important; background:var(--bg-white); border-bottom:1px solid var(--border-slate-200); }
          .app-container.tablet-portrait .app-sidebar { position:fixed !important; left:0 !important; top:0 !important; bottom:0 !important; width:320px !important; max-width:85vw !important; z-index:50000 !important; transform:translateX(-100%) !important; transition:transform 0.3s cubic-bezier(0.4, 0, 0.2, 1) !important; background:var(--bg-white) !important; box-shadow:4px 0 12px var(--shadow-color) !important; flex-shrink:0 !important; }
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
          .text-slate-500 { color:#475569 !important; }
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
          .fixed[role="dialog"][data-state="open"], .fixed[role="alertdialog"][data-state="open"] { padding-bottom:var(--bottom-nav-height) !important; }
          [data-sonner-toaster][data-y-position="bottom"] { bottom:calc(var(--bottom-nav-height) + 0.5rem) !important; }
          /* Hide bottom nav on touch devices (phones/tablets) in landscape orientation */
          @media (orientation: landscape) and (hover: none) and (pointer: coarse) {
            nav[data-mobile-bottom-nav] { display: none !important; }
            :root { --bottom-nav-height: 0px !important; }
          }
          .bg-slate-50 { background-color:#f8fafc !important; }
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