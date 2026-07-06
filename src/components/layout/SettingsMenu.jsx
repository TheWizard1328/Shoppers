import React, { useEffect, useRef, useState } from 'react';
import { useDevice } from '@/components/utils/DeviceContext';
import { RefreshCw, FlaskConical, LogOut } from 'lucide-react';
import DemoModeDialog from '@/components/demo/DemoModeDialog';
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator
} from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MobileSelect } from '@/components/ui/mobile-select';

import { globalFilters } from '../utils/globalFilters';
import { clearUserCache, getEffectiveUser } from '../utils/auth';
import { clearSettingsCache } from '../utils/userSettingsManager';
import { base44 } from '@/api/base44Client';


export default function SettingsMenu({
  currentUser,
  realUser,
  isAppOwner,
  adminImportEnabled,
  onAdminImportToggle,
  themePreference,
  onThemeChange,
  cities,
  onPatientImportClick,
  onDeliveryImportClick,
  isMobile
}) {
  const { isMobile: isMobileDeviceForUI } = useDevice();
  const isMobileForTheme = isMobileDeviceForUI;
  
  const [showDemoModeDialog, setShowDemoModeDialog] = useState(false);
  const [isDemoActive, setIsDemoActive] = useState(false);
  const demoStateLoadedRef = useRef(false);
  const demoStateLoadingRef = useRef(false);

  const handleCityFilterChange = async (cityId) => {
    if (!cityId || cityId === globalFilters.getSelectedCityId()) return;

    globalFilters.updateFilters({
      selectedCityId: cityId,
      selectedStoreId: 'all',
      selectedDriverId: 'all'
    });

    window.dispatchEvent(new CustomEvent('cityChanged', {
      detail: { cityId }
    }));

    clearUserCache();
    clearSettingsCache();

    const refreshedUser = await getEffectiveUser().catch(() => null);

    window.dispatchEvent(new CustomEvent('cityChangedDataReady', {
      detail: {
        cityId,
        refreshedUser
      }
    }));

    window.dispatchEvent(new CustomEvent('forceDataRefresh'));
  };

  useEffect(() => {
    if (!currentUser?.app_roles?.includes('admin')) return;

    const loadDemoState = async (force = false) => {
      if (demoStateLoadingRef.current) return;
      if (demoStateLoadedRef.current && !force) return;

      demoStateLoadingRef.current = true;
      try {
        const rows = await base44.entities.DemoSettings.filter({ user_id: currentUser.id });
        setIsDemoActive(rows?.[0]?.is_demo_mode_active === true);
        demoStateLoadedRef.current = true;
      } catch (error) {
        if (error?.message?.includes('Rate limit exceeded')) return;
      } finally {
        demoStateLoadingRef.current = false;
      }
    };

    loadDemoState();
    const handler = () => loadDemoState(true);
    window.addEventListener('demoModeChanged', handler);
    return () => window.removeEventListener('demoModeChanged', handler);
  }, [currentUser?.id, currentUser?.app_roles]);
  
  return (
    <>
      <DemoModeDialog open={showDemoModeDialog} onOpenChange={setShowDemoModeDialog} />
    <DropdownMenuContent 
      align="end" 
      className="w-60 z-[99999]" 
      style={{ 
        background: 'var(--bg-white)', 
        borderColor: '#ffffff', 
        color: 'var(--text-slate-900)', 
        fontSize: isMobileDeviceForUI ? '16px' : '15px' 
      }}
    >
      {/* Settings header and Admin Import toggle - only for admins/app owners */}

      {/* Display Settings - Admin/Dispatcher/Driver */}
      {currentUser?.app_roles?.includes('admin') || currentUser?.app_roles?.includes('dispatcher') || currentUser?.app_roles?.includes('driver') ? (
        <>
          <DropdownMenuLabel 
            className="px-2 font-semibold uppercase tracking-wider text-slate-500" 
            style={{ fontSize: isMobileDeviceForUI ? '13px' : '12px' }}
          >
            Display
          </DropdownMenuLabel>
          
          {/* Theme Toggle - Mobile Devices Only (based on user agent, not screen width) */}
          {isMobileForTheme && (
        <div className="px-2 py-2">
          <label 
            className="font-medium mb-1.5 block" 
            style={{ 
              color: 'var(--text-slate-700)', 
              fontSize: isMobileDeviceForUI ? '15px' : '14px' 
            }}
          >
            Theme
          </label>
          {isMobileDeviceForUI ? (
            <MobileSelect 
              value={themePreference} 
              onValueChange={onThemeChange}
              options={[
                { value: 'auto', label: 'Auto (System)' },
                { value: 'light', label: 'Light' },
                { value: 'dark', label: 'Dark' }
              ]}
            />
          ) : (
            <Select value={themePreference} onValueChange={onThemeChange}>
              <SelectTrigger 
                className="w-full min-h-11" 
                style={{ 
                  background: 'var(--bg-white)', 
                  borderColor: 'var(--border-slate-300)', 
                  color: 'var(--text-slate-900)', 
                  fontSize: isMobileDeviceForUI ? '16px' : '15px' 
                }}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent 
                className="z-[10003]" 
                style={{ 
                  background: 'var(--bg-white)', 
                  borderColor: '#ffffff', 
                  fontSize: isMobileDeviceForUI ? '16px' : '15px' 
                }}
              >
                <SelectItem value="auto" style={{ color: 'var(--text-slate-900)' }}>Auto (System)</SelectItem>
                <SelectItem value="light" style={{ color: 'var(--text-slate-900)' }}>Light</SelectItem>
                <SelectItem value="dark" style={{ color: 'var(--text-slate-900)' }}>Dark</SelectItem>
              </SelectContent>
            </Select>
          )}
        </div>
      )}
        </>
      ) : null}

      {/* Import Buttons */}

      {/* City Filter - Admin Only */}
      {currentUser?.app_roles?.includes('admin') && cities && cities.length > 0 && (
        <div className="px-2 py-2">
          <label 
            className="font-medium mb-1.5 block" 
            style={{ 
              color: 'var(--text-slate-700)', 
              fontSize: isMobileDeviceForUI ? '14px' : '13px' 
            }}
          >
            City Filter
          </label>
          {isMobileDeviceForUI ? (
            <MobileSelect 
              value={globalFilters.getSelectedCityId()}
              onValueChange={handleCityFilterChange}
              options={cities.map((city) => ({ value: city.id, label: city.name }))}
            />
          ) : (
            <Select
              value={globalFilters.getSelectedCityId()}
              onValueChange={handleCityFilterChange}
            >
              <SelectTrigger 
                className="w-full min-h-11" 
                style={{ 
                  background: 'var(--bg-white)', 
                  borderColor: 'var(--border-slate-300)', 
                  color: 'var(--text-slate-900)', 
                  fontSize: isMobileDeviceForUI ? '16px' : '15px' 
                }}
              >
                <SelectValue placeholder="City" />
              </SelectTrigger>
              <SelectContent 
                className="max-h-[300px] overflow-y-auto z-[10002]" 
                style={{ 
                  background: 'var(--bg-white)', 
                  borderColor: '#ffffff', 
                  fontSize: isMobileDeviceForUI ? '16px' : '15px' 
                }}
              >
                {cities.map((city) => (
                  <SelectItem key={city.id} value={city.id} style={{ color: 'var(--text-slate-900)' }}>
                    {city.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      )}

      {currentUser?.app_roles?.includes('admin') && (
        <>
          <DropdownMenuSeparator style={{ background: 'var(--border-slate-200)' }} />
          <DropdownMenuItem
            onClick={() => setShowDemoModeDialog(true)}
            className="cursor-pointer"
            style={{ fontSize: isMobileDeviceForUI ? '16px' : '15px' }}
          >
            <FlaskConical className={`${isMobileDeviceForUI ? 'w-5 h-5' : 'w-4 h-4'} mr-2`} />
            {isDemoActive ? 'Exit Demo' : 'Demo Mode'}
          </DropdownMenuItem>
        </>
      )}

      {/* Force Full App Refresh */}
      <DropdownMenuSeparator style={{ background: 'var(--border-slate-200)' }} />
      <DropdownMenuItem
        onClick={async () => {
          try {
            clearUserCache();
            clearSettingsCache();
            window.location.reload(true);
          } catch (error) {
            // Silent fail
          }
        }}
        className="cursor-pointer text-blue-600"
        style={{ fontSize: isMobileDeviceForUI ? '16px' : '15px' }}
      >
        <RefreshCw className={`${isMobileDeviceForUI ? 'w-5 h-5' : 'w-4 h-4'} mr-2`} />
        Force Full App Refresh
      </DropdownMenuItem>
      <DropdownMenuSeparator style={{ background: 'var(--border-slate-200)' }} />
      <DropdownMenuItem
        onClick={() => base44.auth.logout('/')}
        className="cursor-pointer text-red-600"
        style={{ fontSize: isMobileDeviceForUI ? '16px' : '15px' }}
      >
        <LogOut className={`${isMobileDeviceForUI ? 'w-5 h-5' : 'w-4 h-4'} mr-2`} />
        Log Out
      </DropdownMenuItem>
    </DropdownMenuContent>
    </>
  );
}