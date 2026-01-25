import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { X, RefreshCw } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { motion, AnimatePresence } from 'framer-motion';
import { saveSetting } from '@/components/utils/userSettingsManager';

export default function VersionChecker({ currentVersion }) {
  const [newVersionAvailable, setNewVersionAvailable] = useState(false);
  const [serverVersion, setServerVersion] = useState(null);
  const [userVersion, setUserVersion] = useState(null);
  const [userId, setUserId] = useState(null);
  const [dismissed, setDismissed] = useState(false);

  // Get current user
  useEffect(() => {
    const getUser = async () => {
      try {
        const user = await base44.auth.me();
        if (user?.id) {
          setUserId(user.id);
        }
      } catch (error) {
        // Silent fail
      }
    };
    getUser();
  }, []);

  useEffect(() => {
    const checkVersion = async () => {
      try {
        const settings = await base44.entities.AppSettings.filter({ setting_key: 'refresh_intervals' });
        if (settings && settings.length > 0 && settings[0].setting_value?.appVersion) {
          const version = settings[0].setting_value.appVersion;
          const versionString = `v${version.major}.${version.minor}.${version.build}`;
          setServerVersion(versionString);
          
          // Load user's stored version if we have a user
          if (userId) {
            try {
              const userSettings = await base44.auth.me();
              const storedVersion = userSettings?.user_version;
              setUserVersion(storedVersion || currentVersion);
              
              // Show notification only if server version is newer than user's version
              if (versionString !== (storedVersion || currentVersion)) {
                setNewVersionAvailable(true);
              }
            } catch (error) {
              // Fall back to currentVersion
              setUserVersion(currentVersion);
              if (versionString !== currentVersion) {
                setNewVersionAvailable(true);
              }
            }
          }
        }
      } catch (error) {
        // Silent fail
      }
    };

    checkVersion();

    // Check every 5 minutes
    const interval = setInterval(checkVersion, 300000);

    return () => clearInterval(interval);
  }, [currentVersion, userId]);

  const handleRefresh = () => {
    // Store the server version as the user's current version
    if (userId && serverVersion) {
      saveSetting(userId, 'user_version', serverVersion);
    }
    
    // Update user data to persist version
    if (userId && serverVersion) {
      base44.auth.updateMe({ user_version: serverVersion }).catch(() => {});
    }
    
    window.location.reload(true);
  };

  const handleDismiss = () => {
    setDismissed(true);
  };

  // Show if new version available, not dismissed, and server version is newer than user version
  const shouldShow = newVersionAvailable && !dismissed && serverVersion && userVersion && serverVersion !== userVersion;

  return (
    <AnimatePresence>
      {shouldShow && (
        <motion.div
          initial={{ opacity: 0, y: -50 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -50 }}
          className="fixed top-4 left-1/2 -translate-x-1/2 z-[100000] max-w-md w-full mx-4"
        >
          <div className="bg-blue-500 text-white rounded-lg shadow-2xl p-4 flex items-center gap-3">
            <RefreshCw className="w-5 h-5 flex-shrink-0" />
            <div className="flex-1">
              <p className="font-semibold text-sm">New Version Available!</p>
              <p className="text-xs opacity-90">
                Update to {serverVersion} for the latest features
              </p>
            </div>
            <Button
              onClick={handleRefresh}
              size="sm"
              className="bg-white text-blue-600 hover:bg-blue-50 flex-shrink-0"
            >
              Refresh
            </Button>
            <button
              onClick={handleDismiss}
              className="p-1 hover:bg-blue-600 rounded transition-colors flex-shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}