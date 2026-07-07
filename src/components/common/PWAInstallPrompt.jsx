import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { X, Download, Smartphone } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

export default function PWAInstallPrompt({ storageKey = 'pwa_install_dismissed' }) {
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [showPrompt, setShowPrompt] = useState(false);

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
          className="fixed bottom-4 left-4 right-4 md:left-auto md:right-4 md:w-96 z-[10000]"
        >
          <div className="bg-white rounded-xl shadow-2xl border-2 border-emerald-500 p-4">
            <div className="flex items-start gap-3">
              <div className="w-12 h-12 bg-emerald-100 rounded-full flex items-center justify-center flex-shrink-0">
                <Smartphone className="w-6 h-6 text-emerald-600" />
              </div>
              
              <div className="flex-1">
                <h4 className="font-semibold text-slate-900 mb-1">Install RxDeliver</h4>
                <p className="text-sm text-slate-600 mb-3">
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
                variant="ghost"
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