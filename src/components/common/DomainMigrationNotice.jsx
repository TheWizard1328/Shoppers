import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import { motion, AnimatePresence } from 'framer-motion';
import { AlertTriangle, Download, ExternalLink, Smartphone, Pin, X } from 'lucide-react';
import { useDevice } from '@/components/utils/DeviceContext';
import { useLatestApkBuildInfo } from '@/components/utils/useBuildInfo';

/**
 * DomainMigrationNotice — owner directive Oct 25 2026 (wizardworxx.com migration)
 *
 * TWO jobs, decided purely by the hostname this bundle is served from:
 *
 * 1) OLD domain (wizardworxx.com / www.wizardworxx.com — still serving RxDeliver
 *    during the transition until the WizardWorxx site takes the root):
 *      a persistent-but-dismissible modal on every new session:
 *      - Native APK (old builds load the old domain): "install the new APK",
 *        with a direct Download button (GitHub apk-latest release).
 *      - Web / PWA: "RxDeliver has moved" — go to the new address and remove
 *        the old shortcut, with an Open button.
 *    "Continue anyway" keeps the app usable mid-shift but reappears next boot.
 *
 * 2) NEW domain (rxdeliver.wizardworxx.com), WEB only, ONCE per device:
 *      - PC: install-the-app prompt (beforeinstallprompt when the browser
 *        supports it, manual instructions otherwise) + pin-to-taskbar tip.
 *      - Android web: prompt to install the native APK (direct download).
 *      - iOS web: Add-to-Home-Screen instructions.
 *    Native APK users get nothing (they already have the app).
 *
 * The preview domain and any other host render nothing.
 */
const OLD_HOSTS = ['wizardworxx.com', 'www.wizardworxx.com'];
const NEW_HOST = 'rxdeliver.wizardworxx.com';
const NEW_URL = `https://${NEW_HOST}`;
const OLD_NOTICE_SESSION_KEY = 'rx_old_domain_notice_dismissed';
const INSTALL_PROMPT_KEY = 'rxdeliver_install_prompt_v1';

const isNativeApp = () => {
  try { return !!(typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.()); } catch (_) { return false; }
};

export default function DomainMigrationNotice() {
  const { isMobile, deviceType, os } = useDevice();
  const { apkUrl, versionLabel } = useLatestApkBuildInfo();
  const [hostname, setHostname] = useState(() => (typeof window !== 'undefined' ? window.location.hostname : ''));
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [showOldNotice, setShowOldNotice] = useState(false);
  const [showInstallPrompt, setShowInstallPrompt] = useState(false);
  const [installDone, setInstallDone] = useState(false);
  // DIALOG-SEQUENCING (owner Oct 26 2026): on first login this notice and the
  // device-registration chooser both open — the Radix modal's body
  // pointer-events lock froze this notice's buttons while the device list
  // behind it stayed clickable. While the chooser is up we now render nothing;
  // it reappears once registration completes (or instantly, when the user is
  // already linked and no chooser ever opens).
  const [deviceDialogUp, setDeviceDialogUp] = useState(false);
  useEffect(() => {
    const onOpened = () => setDeviceDialogUp(true);
    const onDone = () => setDeviceDialogUp(false);
    window.addEventListener('deviceDialogOpened', onOpened);
    window.addEventListener('deviceRegistrationCompleted', onDone);
    return () => {
      window.removeEventListener('deviceDialogOpened', onOpened);
      window.removeEventListener('deviceRegistrationCompleted', onDone);
    };
  }, []);

  const platform = useMemo(() => {
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    const osStr = String(os || '').toLowerCase();
    const isIOS = /iPad|iPhone|iPod/.test(ua) || osStr.includes('ios');
    const isAndroid = /Android/i.test(ua) || osStr.includes('android');
    const isPC = !isMobile && (deviceType === 'desktop' || (!isIOS && !isAndroid));
    return { isIOS, isAndroid, isPC };
  }, [isMobile, deviceType, os]);

  // Capture the browser's native PWA install prompt when available (PCs)
  useEffect(() => {
    const handler = (e) => { try { e.preventDefault(); } catch (_) {} setDeferredPrompt(e); };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const mode = useMemo(() => {
    if (!hostname || hostname.includes('preview')) return 'skip';
    if (OLD_HOSTS.includes(hostname)) return 'old';
    if (hostname === NEW_HOST) return 'new';
    return 'skip';
  }, [hostname]);

  useEffect(() => {
    if (deviceDialogUp) return; // hold: device chooser owns the screen right now
    if (mode === 'old') {
      // every NEW session shows the notice once more (sessionStorage, not
      // localStorage — the notice must persist until the migration completes)
      let dismissed = false;
      try { dismissed = sessionStorage.getItem(OLD_NOTICE_SESSION_KEY) === 'true'; } catch (_) {}
      if (!dismissed) setShowOldNotice(true);
    } else if (mode === 'new' && !isNativeApp()) {
      // once per device, ever
      let shown = false;
      try { shown = localStorage.getItem(INSTALL_PROMPT_KEY) === 'true'; } catch (_) {}
      if (!shown) {
        setShowInstallPrompt(true);
        try {
          localStorage.setItem(INSTALL_PROMPT_KEY, 'true');
          // suppress the generic PWAInstallPrompt banner so the two never stack
          localStorage.setItem('pwa_install_dismissed', 'true');
        } catch (_) {}
      }
    }
  }, [mode, deviceDialogUp]);

  const dismissOldNotice = () => {
    setShowOldNotice(false);
    try { sessionStorage.setItem(OLD_NOTICE_SESSION_KEY, 'true'); } catch (_) {}
  };

  const handlePwaInstall = async () => {
    if (deferredPrompt) {
      try { await deferredPrompt.prompt(); } catch (_) {}
      try { await deferredPrompt.userChoice; } catch (_) {}
      setDeferredPrompt(null);
    }
    setInstallDone(true);
  };

  const dismissInstallPrompt = () => setShowInstallPrompt(false);

  if (typeof document === 'undefined') return null;
  if (deviceDialogUp) return null; // device chooser first — notice follows

  // ── 1) OLD-DOMAIN notice ────────────────────────────────────────────────────
  const oldNotice = (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-[10002] flex items-center justify-center bg-slate-900/70 p-4"
      onClick={dismissOldNotice}
    >
      <motion.div
        initial={{ scale: 0.92, y: 12 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.95, opacity: 0 }}
        transition={{ type: 'spring', stiffness: 280, damping: 24 }}
        className="w-full max-w-sm rounded-xl border-2 border-amber-400 bg-white p-5 shadow-2xl dark:bg-slate-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start gap-3">
          <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-amber-100">
            <AlertTriangle className="h-6 w-6 text-amber-600" />
          </div>
          <div>
            <h4 className="font-semibold text-slate-900 dark:text-slate-100">RxDeliver has a new address</h4>
            <p className="text-xs text-slate-500">{NEW_HOST}</p>
          </div>
        </div>

        {isNativeApp() ? (
          <div className="mb-4 text-sm text-slate-600 dark:text-slate-300">
            This app version is out of date. Please install the new RxDeliver APK{versionLabel ? ` (${versionLabel})` : ''} — it connects to the new address automatically.
          </div>
        ) : (
          <div className="mb-4 text-sm text-slate-600 dark:text-slate-300">
            We're moving. Please install the app from the new address and remove this old one.
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs">
              <li>Open the new address below</li>
              <li>Install the app from there (it will prompt you)</li>
              <li>Remove this old shortcut/bookmark</li>
            </ol>
          </div>
        )}

        <div className="flex flex-col gap-2">
          {isNativeApp() ? (
            apkUrl ? (
              <a href={apkUrl} download className="w-full">
                <Button className="w-full bg-emerald-600 hover:bg-emerald-700">
                  <Download className="mr-2 h-4 w-4" />
                  Download new APK{versionLabel ? ` ${versionLabel}` : ''}
                </Button>
              </a>
            ) : (
              <div className="rounded-lg bg-slate-100 p-2 text-center text-xs text-slate-500 dark:bg-slate-800">
                APK download unavailable right now — ask Robert for the new APK install link.
              </div>
            )
          ) : (
            <a href={NEW_URL} className="w-full">
              <Button className="w-full bg-emerald-600 hover:bg-emerald-700">
                <ExternalLink className="mr-2 h-4 w-4" />
                Open {NEW_HOST}
              </Button>
            </a>
          )}
          <Button variant="outline" className="w-full text-slate-500" onClick={dismissOldNotice}>
            Continue anyway (old address)
          </Button>
        </div>
      </motion.div>
    </motion.div>
  );

  // ── 2) NEW-DOMAIN first-boot install prompt (web only) ─────────────────────
  const installPrompt = (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-[10002] flex items-center justify-center bg-slate-900/70 p-4"
      onClick={dismissInstallPrompt}
    >
      <motion.div
        initial={{ scale: 0.92, y: 12 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.95, opacity: 0 }}
        transition={{ type: 'spring', stiffness: 280, damping: 24 }}
        className="w-full max-w-sm rounded-xl border-2 border-emerald-500 bg-white p-5 shadow-2xl dark:bg-slate-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start gap-3">
          <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-emerald-100">
            <Smartphone className="h-6 w-6 text-emerald-600" />
          </div>
          <div>
            <h4 className="font-semibold text-slate-900 dark:text-slate-100">Install RxDeliver</h4>
            <p className="text-xs text-slate-500">You're on the new official address — install the app so it sticks.</p>
          </div>
        </div>

        {platform.isPC ? (
          <>
            <p className="mb-3 text-sm text-slate-600 dark:text-slate-300">
              Install RxDeliver as a desktop app for faster access and its own window.
            </p>
            <div className="mb-3 flex items-start gap-2 rounded-lg bg-sky-50 p-2 text-xs text-sky-800 dark:bg-sky-950 dark:text-sky-200">
              <Pin className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <span>After installing, right-click the app's icon and choose "Pin to taskbar" so it's always one click away.</span>
            </div>
            {deferredPrompt ? (
              <Button className="w-full bg-emerald-600 hover:bg-emerald-700" onClick={handlePwaInstall}>
                <Download className="mr-2 h-4 w-4" />
                Install app
              </Button>
            ) : (
              <div className="rounded-lg bg-slate-100 p-2 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                In your browser's address bar (or menu ⋮), choose <b>Install</b> or <b>Install RxDeliver as an app</b>. Your browser will remember it.
              </div>
            )}
          </>
        ) : platform.isAndroid ? (
          <>
            <p className="mb-3 text-sm text-slate-600 dark:text-slate-300">
              Install the RxDeliver app (APK){versionLabel ? ` — latest version ${versionLabel}` : ''}. It's faster, has native GPS and push notifications.
            </p>
            {apkUrl ? (
              <a href={apkUrl} download className="w-full">
                <Button className="w-full bg-emerald-600 hover:bg-emerald-700">
                  <Download className="mr-2 h-4 w-4" />
                  Download the app (APK)
                </Button>
              </a>
            ) : (
              <div className="rounded-lg bg-slate-100 p-2 text-center text-xs text-slate-500 dark:bg-slate-800">
                Download not available right now — ask Robert for the APK install link.
              </div>
            )}
          </>
        ) : (
          <>
            <p className="mb-3 text-sm text-slate-600 dark:text-slate-300">
              Add RxDeliver to your home screen so it works like an app:
            </p>
            <div className="rounded-lg bg-slate-100 p-2 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
              Tap the <b>Share</b> button, then choose <b>Add to Home Screen</b>.
            </div>
          </>
        )}

        <Button variant="outline" className="mt-3 w-full text-slate-500" onClick={dismissInstallPrompt}>
          {installDone ? 'Done' : 'Maybe later'}
        </Button>
      </motion.div>
    </motion.div>
  );

  return createPortal(
    <AnimatePresence>
      {showOldNotice && mode === 'old' && oldNotice}
      {showInstallPrompt && mode === 'new' && !isNativeApp() && installPrompt}
    </AnimatePresence>,
    document.body
  );
}
