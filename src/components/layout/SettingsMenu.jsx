import React from 'react';
import { FileText, RefreshCw, Database, Cloud } from 'lucide-react';
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator
} from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import MobileSelect from '@/components/ui/mobile-select';
import { isMobileDevice, isMobileDeviceForTheme } from '../utils/deviceUtils';
import { globalFilters } from '../utils/globalFilters';
import { clearUserCache } from '../utils/auth';
import { clearSettingsCache } from '../utils/userSettingsManager';
import { base44 } from '@/api/base44Client';
import { toast } from 'sonner';

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
  const isMobileDeviceForUI = isMobile !== undefined ? isMobile : isMobileDevice();
  const isMobileForTheme = isMobileDeviceForTheme();
  
  return (
    <DropdownMenuContent 
      align="end" 
      className="w-60 z-[10002]" 
      style={{ 
        background: 'var(--bg-white)', 
        borderColor: '#ffffff', 
        color: 'var(--text-slate-900)', 
        fontSize: isMobileDeviceForUI ? '16px' : '15px' 
      }}
    >
      {/* Settings header and Admin Import toggle - only for admins/app owners */}
      {(currentUser?.app_roles?.includes('admin') || isAppOwner) && (
        <>
          <div className="px-2 py-2">
            <div className="flex items-center justify-between">
              <DropdownMenuLabel 
                className="p-0" 
                style={{ 
                  color: 'var(--text-slate-900)', 
                  fontSize: isMobileDeviceForUI ? '16px' : '15px' 
                }}
              >
                Settings
              </DropdownMenuLabel>
              {isAppOwner && (
                <label className="flex items-center gap-2 cursor-pointer">
                  <span 
                    className="font-medium" 
                    style={{ 
                      color: 'var(--text-slate-600)', 
                      fontSize: isMobileDeviceForUI ? '14px' : '13px' 
                    }}
                  >
                    Admin Import
                  </span>
                  <Switch
                    checked={adminImportEnabled}
                    onCheckedChange={onAdminImportToggle}
                  />
                </label>
              )}
            </div>
          </div>
          <DropdownMenuSeparator style={{ background: 'var(--border-slate-200)' }} />
        </>
      )}

      {/* Display Settings */}
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
                className="w-full h-9" 
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

      {/* Import Buttons */}
      {(realUser && isAppOwner || adminImportEnabled) && (
        <>
          <DropdownMenuLabel 
            className="px-2 font-semibold uppercase tracking-wider text-slate-500" 
            style={{ fontSize: isMobileDeviceForUI ? '13px' : '12px' }}
          >
            Deliveries
          </DropdownMenuLabel>
          {(realUser && isAppOwner || adminImportEnabled) && (
            <DropdownMenuItem 
              onClick={onPatientImportClick} 
              className="cursor-pointer" 
              style={{ fontSize: isMobileDeviceForUI ? '16px' : '15px' }}
            >
              <FileText className={`${isMobileDeviceForUI ? 'w-5 h-5' : 'w-4 h-4'} mr-2`} />
              Patient Data
            </DropdownMenuItem>
          )}
          <DropdownMenuItem 
            onClick={onDeliveryImportClick} 
            className="cursor-pointer" 
            style={{ fontSize: isMobileDeviceForUI ? '16px' : '15px' }}
          >
            <FileText className={`${isMobileDeviceForUI ? 'w-5 h-5' : 'w-4 h-4'} mr-2`} />
            Deliveries
          </DropdownMenuItem>
          <DropdownMenuSeparator style={{ background: 'var(--border-slate-200)' }} />
        </>
      )}

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
              onValueChange={(cityId) => {
                globalFilters.setSelectedCityId(cityId);
              }}
              options={cities.map((city) => ({ value: city.id, label: city.name }))}
            />
          ) : (
            <Select
              value={globalFilters.getSelectedCityId()}
              onValueChange={(cityId) => {
                globalFilters.setSelectedCityId(cityId);
              }}
            >
              <SelectTrigger 
                className="w-full h-9" 
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
       </DropdownMenuSeparator>
    </DropdownMenuContent>
  );
}