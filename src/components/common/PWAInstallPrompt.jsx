import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { X, Download, Smartphone } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

export default function PWAInstallPrompt({ storageKey = 'pwa_install_dismissed' }) {
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [showPrompt, setShowPrompt] = useState(false);
  // OWNER REPORT (Nov 25 2026): the Install panel sat at inset-bottom + 1rem,
  // which on a phone is exactly where the mobile bottom nav lives, so the nav
  // row (Dashboard / Balances / Patients / Routes) was half hidden behind the
  // card. The panel now measures that nav and lifts clear of it, instead of
  // guessing a fixed offset that breaks on another layout.
  const [navLift, setNavLift] = useState(0);

  useEffect(() => {
    if (!showPrompt) return undefined;
    const measure = () => {
      const nav = document.querySelector('[data-mobile-bottom-nav]');
      const narrow = typeof window !== 'undefined' && window.matchMedia
        ? window.matchMedia('(max-width: 767px)').matches
        : false;
      const h = nav ? Math.round(nav.getBoundingClientRect().height || 0) : 0;
      setNavLift(narrow && h > 0 ? h : 0);
    };
    measure();
    // The nav mounts with the layout, so one delayed pass catches it when the
    // prompt appears before the nav has been measured.
    const late = setTimeout(measure, 400);
    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);
    return () => {
      clearTimeout(late);
      window.removeEventListener('resize', measure);
      window.removeEventListener('orientationchange', measure);
    };
  }, [showPrompt]);

  useEffect(() => {
    // Check if already dismissed
    const dismissed = localStorage.getItem(storageKey);
    if (dismissed === 'true') return;

    // Listen for install prompt
    const handleBeforeInstallPrompt = (e) => {
      e.preventDefault();
      setDeferredPrompt(e);
      
      // Show prompt after 10 seconds
      setTimeout(() => {
        setShowPrompt(true);
      }, 10000);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    };
  }, []);

  const handleInstall = async () => {
    if (!deferredPrompt) return;

    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;

    if (outcome === 'accepted') {
      console.log('PWA installed');
    }

    setDeferredPrompt(null);
    setShowPrompt(false);
  };

  const handleDismiss = () => {
    setShowPrompt(false);
    localStorage.setItem(storageKey, 'true');
  };

  return (
    <AnimatePresence>
      {showPrompt && (
        <motion.div
          initial={{ y: 100, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 100, opacity: 0 }}
          /* z-[10005]: above the mobile bottom nav (z-150) and the nudge stack,
             so the panel is never drawn behind the bar it now clears. */
          style={{ bottom: `calc(var(--app-inset-bottom) + 1rem + ${navLift}px)` }}
          className="fixed left-4 right-4 md:left-auto md:right-4 md:w-96 z-[10005]"
        >
          <div className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl border-2 border-emerald-500 p-4">
            <div className="flex items-start gap-3">
              <div className="w-12 h-12 bg-emerald-100 rounded-full flex items-center justify-center flex-shrink-0">
                <Smartphone className="w-6 h-6 text-emerald-600" />
              </div>
              
              <div className="flex-1">
                <h4 className="font-semibold text-slate-900 dark:text-slate-100 mb-1">Install RxDeliver</h4>
                <p className="text-sm text-slate-600 dark:text-slate-400 mb-3">
                  Add to your home screen for faster access and offline support
                </p>
                
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    onClick={handleInstall}
                    className="bg-emerald-600 hover:bg-emerald-700 flex-1"
                  >
                    <Download className="w-4 h-4 mr-2" />
                    Install
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleDismiss}
                  >
                    Not Now
                  </Button>
                </div>
              </div>

              <Button
 aria-label="Dismiss install prompt"                variant="ghost"
                size="icon"
                className="w-6 h-6"
                onClick={handleDismiss}
              >
                <X className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}