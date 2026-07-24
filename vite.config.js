import path from 'path'
import base44 from "@base44/vite-plugin"
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  logLevel: 'error', // Suppress warnings, only show errors
  plugins: [
    base44({
      // Support for legacy code that imports the base44 SDK with @/integrations, @/entities, etc.
      // can be removed if the code has been updated to use the new SDK imports from @base44/sdk
      legacySDKImports: true,
      hmrNotifier: true,
      navigationNotifier: true,
      analyticsTracker: true,
      visualEditAgent: true
    }),
    react(),
  ],
  resolve: {
    alias: {
      // dompurify@2.5.x ships an empty "exports" field which breaks Vite/rollup
      // resolution. Point it directly to the CJS bundle so jsPDF's optional
      // dynamic import('dompurify') always resolves cleanly in production builds.
      'dompurify': path.resolve(__dirname, 'node_modules/dompurify/dist/purify.cjs.js'),
    },
  },
  optimizeDeps: {
    // Pre-bundle dompurify using the alias above so Vite's dep-optimizer
    // also bypasses the broken exports field during dev.
    include: ['dompurify'],
  },
  build: {
    // Strip all console.* calls from production builds for performance.
    // 1,240+ console.log statements were shipping to prod and executing on
    // every GPS tick, WebSocket message, and state update on mobile devices.
    // console.error and console.warn are preserved for debugging.
    minify: 'terser',
    terserOptions: {
      compress: {
        drop_console: false, // Keep console.log in case of debugging needs
        // Instead, use pure_funcs to remove only console.log and console.debug
        pure_funcs: ['console.log', 'console.debug'],
      },
    },
    rollupOptions: {
      onwarn(warning, warn) {
        // Suppress "use client" directive warnings from UI libs
        if (warning.code === 'MODULE_LEVEL_DIRECTIVE') return;
        warn(warning);
      },
    },
  },
});
