import React from 'react';
import { useDevice } from '@/components/utils/DeviceContext';
import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { globalFilters } from '../utils/globalFilters';

// ── Fridge temp thresholds for sidebar driver badges ──────────────────────
let _sidebarFridgeCfg = { safe_min: 2, safe_max: 6, danger_buffer: 2 };
(async () => {
  try {
    const { base44: b44 } = await import('@/api/base44Client');
    const s = await b44.entities.AppSettings.filter({ setting_key: 'refresh_intervals' });
    const ft = s?.[0]?.setting_value?.fridge_temp_settings;
    if (typeof ft?.safe_min === 'number') _sidebarFridgeCfg.safe_min = ft.safe_min;
    if (typeof ft?.safe_max === 'number') _sidebarFridgeCfg.safe_max = ft.safe_max;
    if (typeof ft?.danger_buffer === 'number') _sidebarFridgeCfg.danger_buffer = ft.danger_buffer;
  } catch (_) {}
})();
import { userHasRole, isAppOwner } from '../utils/userRoles';

import { MoreVertical, X, LayoutDashboard, Users, Package, Building, Truck, DollarSign, BarChart3, Smartphone, CalendarDays, Thermometer, Settings, FolderLock } from 'lucide-react';
import { isMobileDevice as isMobileDeviceForTheme } from '../utils/deviceUtils';
import { DropdownMenu, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import SettingsMenu from './SettingsMenu';
import DriverStatusToggle from './DriverStatusToggle';
import LocationTrackingToggle from './LocationTrackingToggle';
import SidebarDivider from './SidebarDivider';
import SidebarSectionLabel from './SidebarSectionLabel';
import SidebarUserFooter from './SidebarUserFooter';
import AdminNavigationSection from './AdminNavigationSection';
import QuickStats from './DashboardQuickStats';
import BatteryIndicator from './BatteryIndicator';
import { base44 } from '@/api/base44Client';
import { getEffectiveUser, clearUserCache } from '../utils/auth';
import { calculateRouteCodBalance } from '../utils/codTotalCalculator';
import { createPageUrl } from '../../utils';
import { useSidebarEntitySubscriptions } from './useSidebarEntitySubscriptions';

/**
 * AppSidebar
 * All sidebar JSX extracted from Layout.jsx.
 * Receives props from Layout; zero internal state.
 */
export default function AppSidebar({
  sidebarOpen, setSidebarOpen,
  branding, appVersion,
  currentUser, setCurrentUser,
  currentPageName,
  stores, cities, drivers, users, appUsers,
  patients,
  filteredDeliveries,
  deliveries,
  screenWidth,
  unreadMessageCount, setUnreadMessageCount,
  setShowMessaging, setInitialConversation,
  setShowInviteQRModal,
  entityCounts,
  adminNavigationItems,
  adminImportEnabled, setAdminImportEnabled,
  themePreference, handleThemeChange,
  setShowPatientImport, setShowDeliveryImport,
  constructUrlWithParams,
  getRouteNavigationUrl,
  getOverviewUrl,
  currentPayrollNetPay,
  onlineCounts,
  totalRoutesCount
}) {
  const { isMobile, isTabletPortrait, isWideScreenMobile, deviceType } = useDevice();

  // Subscribe to all key entities for real-time sidebar updates
  useSidebarEntitySubscriptions(currentUser);

  // Resolve the currently selected driver so the toggle targets them (admin only)
  const selectedDriverId = globalFilters.getSelectedDriverId();
  const selectedDriverAppUser = useMemo(() => {
    if (!userHasRole(currentUser, 'admin')) return null;
    if (!selectedDriverId || selectedDriverId === 'all') return null;
    return (appUsers || []).find((au) => au && au.user_id === selectedDriverId) || null;
  }, [currentUser, selectedDriverId, appUsers]);

  // Build a merged user object the toggle can use as targetUser
  const selectedDriverTarget = useMemo(() => {
    if (!selectedDriverAppUser) return null;
    const baseUser = (users || []).find((u) => u && u.id === selectedDriverAppUser.user_id);
    return {
      ...(baseUser || {}),
      ...selectedDriverAppUser,
      id: selectedDriverAppUser.user_id,
      driver_status: selectedDriverAppUser.driver_status || 'off_duty',
      current_latitude: selectedDriverAppUser.current_latitude,
      current_longitude: selectedDriverAppUser.current_longitude
    };
  }, [selectedDriverAppUser, users]);

  // Fetch booked-off overrides for the scheduling badge + keep in sync via WebSocket
  const [bookedOffOverrides, setBookedOffOverrides] = useState([]);
  useEffect(() => {
    if (!userHasRole(currentUser, 'admin') && !userHasRole(currentUser, 'driver')) return;
    base44.entities.DriverScheduleOverride.filter({ driver_id: '__booked_off__' }).
    then(setBookedOffOverrides).
    catch(() => {});

    const unsubscribe = base44.entities.DriverScheduleOverride.subscribe((event) => {
      if (event.type === 'delete') {
        setBookedOffOverrides((prev) => prev.filter((o) => o.id !== event.id));
      } else {
        const o = event.data;
        if (!o) return;
        setBookedOffOverrides((prev) => {
          if (o.driver_id === '__booked_off__') {
            const idx = prev.findIndex((x) => x.id === o.id);
            if (idx >= 0) return prev.map((x) => x.id === o.id ? { ...x, ...o } : x);
            return [...prev, o];
          } else {
            // driver accepted / reassigned — remove from booked-off list
            return prev.filter((x) => x.id !== o.id);
          }
        });
      }
    });
    return unsubscribe;
  }, [currentUser?.id]);

  // Pending doc access requests badge
  const [pendingDocRequestCount, setPendingDocRequestCount] = useState(0);
  // Dispatcher-specific doc badges: red = pending requests count, green = approved+unviewed count
  const [dispatcherDocBadges, setDispatcherDocBadges] = useState({ pending: 0, approvedUnviewed: 0 });

  useEffect(() => {
    if (!currentUser?.id) return;
    const fetchPending = async () => {
      try {
        if (userHasRole(currentUser, 'admin')) {
          const requests = await base44.entities.DocAccessRequest.filter({ status: 'pending' }, '-requested_at', 100);
          setPendingDocRequestCount((requests || []).length);
        } else if (userHasRole(currentUser, 'driver')) {
          const requests = await base44.entities.DocAccessRequest.filter({ driver_id: currentUser.id, status: 'pending' }, '-requested_at', 50);
          setPendingDocRequestCount((requests || []).length);
        } else if (userHasRole(currentUser, 'dispatcher')) {
          const allMyRequests = await base44.entities.DocAccessRequest.filter({ requester_id: currentUser.id }, '-requested_at', 100);
          const now = new Date();
          const pending = (allMyRequests || []).filter(r => r.status === 'pending').length;
          const approvedUnviewed = (allMyRequests || []).filter(r => {
            if (r.status !== 'approved') return false;
            if (r.first_viewed_at) return false; // already viewed
            if (r.expires_at && now > new Date(r.expires_at)) return false; // expired
            return true;
          }).length;
          setDispatcherDocBadges({ pending, approvedUnviewed });
          setPendingDocRequestCount(pending + approvedUnviewed);
        }
      } catch (_) {}
    };
    fetchPending();
    const unsubscribe = base44.entities.DocAccessRequest.subscribe(() => fetchPending());
    return unsubscribe;
  }, [currentUser?.id]);

  const bookedOffCount = useMemo(() => {
    const today = new Date();
    const year = today.getFullYear();
    const month = today.getMonth();
    const daysLeft = new Date(year, month + 1, 0).getDate() - today.getDate();
    const includeNext = daysLeft < 7;

    return bookedOffOverrides.filter((o) => {
      if (!o.date) return false;
      const d = new Date(o.date + 'T00:00:00');
      if (d < today) return false;
      const sameMonth = d.getFullYear() === year && d.getMonth() === month;
      const nextMonth = d.getFullYear() === (month === 11 ? year + 1 : year) && d.getMonth() === (month + 1) % 12;
      return sameMonth || includeNext && nextMonth;
    }).length;
  }, [bookedOffOverrides]);

  return (
    <>
{/* Sidebar */}
<div className={`app-sidebar ${sidebarOpen ? 'sidebar-open' : ''} border-r flex flex-col z-[200]`} style={{ borderColor: 'var(--border-slate-200)', background: 'var(--bg-white)' }}>
  <div className="border-b p-4 flex-shrink-0" style={{ borderColor: 'var(--border-slate-200)' }}>
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-3">
        {/* Close button - show when sidebar is open (always on mobile, on desktop when expanded) */}
        {sidebarOpen &&
              <button
                onClick={() => setSidebarOpen(false)}
                className="p-2 rounded-lg transition-colors hover:bg-slate-100">
            <X className="w-5 h-5" style={{ color: 'var(--text-slate-700)' }} />
          </button>
              }

        {branding.logo_url && !branding.logo_url.includes('placehold') ?
              <img
                src={branding.logo_url}
                alt="RxDeliver"
                className="rounded object-contain w-12 h-12"
                style={{ filter: 'var(--image-filter, none)' }}
                onError={(e) => {e.currentTarget.style.display = 'none';}} /> :


              <div className="w-10 h-10 rounded bg-emerald-700 flex items-center justify-center flex-shrink-0">
            <span className="text-white font-bold text-sm">Rx</span>
          </div>
              }

        <div>
          <h2 className="font-bold text-lg" style={{ color: 'var(--text-slate-900)' }}>
            {'RxDeliver'}
          </h2>
          <p className="text-xs" style={{ color: 'var(--text-slate-500)' }}>Pharmacy Logistics</p>
          <div className="flex items-center gap-1">
            <p className="text-xs" style={{ color: 'var(--text-slate-500)' }}>{appVersion}</p>
            {!isMobile && !isTabletPortrait && !isWideScreenMobile && !(deviceType === 'Tablet' && !isTabletPortrait) && <BatteryIndicator />}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2">
        {/* Show controls in navigation panel when tablet landscape OR landscape mobile */}
        {deviceType === 'Tablet' && !isTabletPortrait || !isMobile && !isTabletPortrait && (userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'driver')) && cities && cities.length > 0 ?
              <>
            {/* Layout: [menu ⋮ on top, battery below] | [status toggle] */}
            <div className="flex items-center gap-1">
              {/* Left column: menu ⋮ on top, battery below */}
              <div className="flex flex-col items-center gap-1">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                      <MoreVertical className="w-4 h-4 text-slate-500" />
                    </Button>
                  </DropdownMenuTrigger>
                  <SettingsMenu
                        currentUser={currentUser}
                        isAppOwner={isAppOwner(currentUser)}
                        adminImportEnabled={adminImportEnabled}
                        onAdminImportToggle={async (checked) => {
                          setAdminImportEnabled(checked);
                          try {
                            const settings = await base44.entities.AppSettings.filter({ setting_key: 'refresh_intervals' });
                            if (settings && settings.length > 0) {
                              await base44.entities.AppSettings.update(settings[0].id, {
                                setting_value: {
                                  ...settings[0].setting_value,
                                  adminImportEnabled: checked
                                }
                              });
                            }
                          } catch (error) {
                            console.error('Failed to save admin import setting:', error);
                          }
                        }}
                        themePreference={themePreference}
                        onThemeChange={handleThemeChange}
                        cities={cities}
                        onPatientImportClick={() => setShowPatientImport(true)}
                        onDeliveryImportClick={() => setShowDeliveryImport(true)}
                        isMobile={isMobile} />
                </DropdownMenu>
                {(isWideScreenMobile || deviceType === 'Tablet' && !isTabletPortrait) && currentUser &&
                    <BatteryIndicator vertical={true} />
                    }
              </div>
              {/* Right column: status toggle — landscape mobile/tablet AND desktop drivers */}
              {currentUser && (userHasRole(currentUser, 'driver') || userHasRole(currentUser, 'admin')) &&
                  <DriverStatusToggle
                    currentUser={currentUser}
                    targetUser={selectedDriverTarget}
                    vertical={true}
                    onStatusChange={async () => {
                      clearUserCache();
                      const refreshedUser = await getEffectiveUser();
                      if (refreshedUser) setCurrentUser(refreshedUser);
                    }} />
                  }
            </div>
          </> : null
              }
      </div>
    </div>
  </div>

  <div className="pt-1 flex-1 overflow-y-auto custom-scrollbar pr-2 pl-2 pb-2" style={{ background: 'var(--bg-white)' }} onClickCapture={(e) => {if ((isMobile || isTabletPortrait) && e.target?.closest?.('a')) {window.dispatchEvent(new CustomEvent('overlayNavigateClose'));}}}>
    <div className="py-0.5">
      <Link
              to={constructUrlWithParams("Dashboard")}
              onClick={() => setSidebarOpen(false)} className="px-4 rounded-xl flex items-center gap-3 transition-all duration-200 hover:opacity-80 py-1"

              style={currentPageName === 'Dashboard' ? {
                background: 'var(--bg-slate-100)',
                color: 'var(--text-slate-900)'
              } : {
                color: 'var(--text-slate-600)'
              }}>
        <LayoutDashboard className="w-5 h-5" />
        <span className="font-semibold">Dashboard</span>
      </Link>

      {(userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'driver')) &&
            <Link
              to={createPageUrl('DriverScheduleCalendar')}
              onClick={() => setSidebarOpen(false)}
              className={`px-4 rounded-xl flex items-center gap-2 transition-all duration-200 py-1 ${
              currentPageName === 'DriverScheduleCalendar' ?
              'shadow-sm' :
              'hover:opacity-80'}`
              }
              style={currentPageName === 'DriverScheduleCalendar' ? {
                background: 'var(--bg-slate-100)',
                color: 'var(--text-slate-900)'
              } : {
                color: 'var(--text-slate-600)'
              }}>
          <CalendarDays className="w-5 h-5" />
          <span className="font-semibold">Scheduling</span>
          {bookedOffCount > 0 &&
              <Badge variant="secondary" className="ml-auto justify-center rounded-[10px] px-2" style={{ background: '#fff7ed', color: '#c2410c' }}>
              🚫 {bookedOffCount}
            </Badge>
              }
        </Link>
            }

      <SidebarDivider />

      {(userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher')) &&
            <Link
              to={createPageUrl('Patients')}
              onClick={() => setSidebarOpen(false)}
              className={`px-4 rounded-xl flex items-center gap-2 transition-all duration-200 py-0.5 ${
              currentPageName === 'Patients' ?
              'shadow-sm' :
              'hover:opacity-80'}`
              }
              style={currentPageName === 'Patients' ? {
                background: 'var(--bg-slate-100)',
                color: 'var(--text-slate-900)'
              } : {
                color: 'var(--text-slate-600)'
              }}>
            <Users className="w-5 h-5" />
            <span className="font-semibold">Patients</span>
            <Badge variant="secondary" className="ml-auto justify-center rounded-[10px] w-[50px]" style={{ background: 'var(--bg-slate-200)', color: 'var(--text-slate-600)' }}>{userHasRole(currentUser, 'admin') ? entityCounts.patients : patients.filter((p) => p && currentUser?.store_ids?.includes(p.store_id)).length}</Badge>
            </Link>
            }

      {(userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher') || userHasRole(currentUser, 'driver')) &&
            <Link
              to={getRouteNavigationUrl('Deliveries')}
              onClick={() => setSidebarOpen(false)}
              className={`px-4 rounded-xl flex items-center gap-2 transition-all duration-200 py-0.5 ${
              currentPageName === 'Deliveries' ?
              'shadow-sm' :
              'hover:opacity-80'}`
              }
              style={currentPageName === 'Deliveries' ? {
                background: 'var(--bg-slate-100)',
                color: 'var(--text-slate-900)'
              } : {
                color: 'var(--text-slate-600)'
              }}>
            <Package className="w-5 h-5" />
            <span className="font-semibold">Routes</span>
            <Badge variant="secondary" className="ml-auto justify-center rounded-[10px] w-[50px]" style={{ background: 'var(--bg-slate-200)', color: 'var(--text-slate-600)' }}>{totalRoutesCount}</Badge>
            </Link>
            }

            {(userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'driver')) &&
            <Link
              to={constructUrlWithParams(createPageUrl('Stores'))}
              onClick={() => {if (currentUser?.status !== 'inactive') setSidebarOpen(false);else {/* prevent navigation */}}}
              className={`px-4 rounded-xl flex items-center gap-2 transition-all duration-200 py-0.5 ${
              currentUser?.status === 'inactive' ? 'opacity-50 pointer-events-none' : currentPageName === 'Stores' ? 'shadow-sm hover:opacity-80' : 'hover:opacity-80'}`
              }
              style={currentPageName === 'Stores' ? {
                background: 'var(--bg-slate-100)',
                color: 'var(--text-slate-900)'
              } : {
                color: 'var(--text-slate-600)'
              }}>
             <Building className="w-5 h-5" />
             <span className="font-semibold">Stores</span>
             <Badge variant="secondary" className="ml-auto justify-center w-[50px] rounded-[10px]" style={{ background: 'var(--bg-slate-200)', color: 'var(--text-slate-600)' }}>{`${onlineCounts.onlineStoresCount}/${stores.length}`}</Badge>
             </Link>
            }

            {(userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher') || userHasRole(currentUser, 'driver')) &&
            <div>
              <Link
                to={constructUrlWithParams('DriverSettings')}
                onClick={() => {if (currentUser?.status !== 'inactive') setSidebarOpen(false);}}
                className={`px-4 rounded-xl flex items-center gap-2 transition-all duration-200 py-0.5 ${
                currentUser?.status === 'inactive' ? 'opacity-50 pointer-events-none' : currentPageName === 'Drivers' ? 'shadow-sm hover:opacity-80' : 'hover:opacity-80'}`
                }
                style={currentPageName === 'Drivers' ? {
                  background: 'var(--bg-slate-100)',
                  color: 'var(--text-slate-900)'
                } : {
                  color: 'var(--text-slate-600)'
                }}>
               <Truck className="w-5 h-5" />
               <span className="font-semibold">Drivers</span>
               <Badge variant="secondary" className="ml-auto justify-center w-[50px] rounded-[10px]" style={{ background: 'var(--bg-slate-200)', color: 'var(--text-slate-600)' }}>{`${onlineCounts.onlineDriversCount}/${drivers.length}`}</Badge>
              </Link>

              {/* Fridge temp badges per driver - dispatchers only */}
              {userHasRole(currentUser, 'dispatcher') && !userHasRole(currentUser, 'admin') && (() => {
                const today = globalFilters.getSelectedDate();
                const activeDriverIds = [...new Set(
                  (deliveries || []).
                  filter((d) => d && d.delivery_date === today && d.driver_id && d.fridge_item).
                  map((d) => d.driver_id)
                )];
                if (activeDriverIds.length === 0) return null;
                return (
                  <div className="pl-10 pr-2 pb-1 space-y-0.5">
                    {activeDriverIds.map((driverId) => {
                      const driver = (appUsers || []).find((au) => au?.user_id === driverId) || (drivers || []).find((d) => d?.id === driverId);
                      const driverName = driver?.user_name || driver?.driver_name || driverId;
                      const fridgeDeliveries = (deliveries || []).filter((d) => d && d.delivery_date === today && d.driver_id === driverId && d.fridge_item);
                      let lastTemp = null;
                      fridgeDeliveries.forEach((d) => {
                        (d.temperature_readings || []).forEach((r) => {
                          if (r.temperature_celsius != null && (!lastTemp || r.timestamp > lastTemp.timestamp)) lastTemp = r;
                        });
                      });
                      const tempDisplay = lastTemp ? `${lastTemp.temperature_celsius.toFixed(1)}°C` : 'N/A';
                      // Color logic: green = within safe zone, yellow = within buffer, red = outside buffer
                      // Uses module-level _sidebarFridgeCfg loaded from AppSettings (defaults: 2/6/±2)
                      const t = lastTemp?.temperature_celsius;
                      const { safe_min: sbMin, safe_max: sbMax, danger_buffer: sbBuf } = _sidebarFridgeCfg;
                      const tempColor = !lastTemp ? '#64748b' :
                      t < sbMin - sbBuf || t > sbMax + sbBuf ? '#991b1b' :
                      t < sbMin || t > sbMax ? '#92400e' :
                      '#166534';
                      const tempBg = !lastTemp ? '#f1f5f9' :
                      t < sbMin - sbBuf || t > sbMax + sbBuf ? '#fee2e2' :
                      t < sbMin || t > sbMax ? '#fef3c7' :
                      '#dcfce7';
                      return null;







                    })}
                  </div>);

              })()}
            </div>
            }

            <div className="border-t mb-2 py-0.5 mt-1" style={{ borderColor: 'var(--border-slate-200)' }}></div>

      {/* Square COD - Admins and Drivers only, clickable only if active */}
      {(userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'driver')) &&
            <Link
              to={createPageUrl('SquareManagement')}
              onClick={() => {if (currentUser?.status !== 'inactive') setSidebarOpen(false);}}
              className={`px-4 rounded-xl flex items-center gap-2 transition-all duration-200 py-0.5 ${
              currentUser?.status === 'inactive' ? 'opacity-50 pointer-events-none' : currentPageName === 'SquareManagement' ? 'shadow-sm hover:opacity-80' : 'hover:opacity-80'}`
              }
              style={currentPageName === 'SquareManagement' ? {
                background: 'var(--bg-slate-100)',
                color: 'var(--text-slate-900)'
              } : {
                color: 'var(--text-slate-600)'
              }}>
            <DollarSign className="w-5 h-5" />
            <span className="font-semibold">Square COD</span>
            {(() => {const bal = calculateRouteCodBalance(deliveries, globalFilters.getSelectedDriverId(), globalFilters.getSelectedDate());return <Badge variant="secondary" className="ml-auto justify-center w-auto px-2 rounded-[10px]" style={{ background: bal > 0 ? '#fef3c7' : 'var(--bg-slate-200)', color: bal > 0 ? '#92400e' : 'var(--text-slate-600)' }}>${bal.toFixed(2)}</Badge>;})()}
            </Link>
            }

      {/* Driver Payroll - Admins and Drivers, always clickable to see payroll */}
      {(userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'driver')) &&
            <Link
              to={createPageUrl('DriverPayroll')}
              onClick={() => setSidebarOpen(false)}
              className={`px-4 rounded-xl flex items-center gap-2 transition-all duration-200 py-0.5 ${
              currentPageName === 'DriverPayroll' ?
              'shadow-sm' :
              'hover:opacity-80'}`
              }
              style={currentPageName === 'DriverPayroll' ? {
                background: 'var(--bg-slate-100)',
                color: 'var(--text-slate-900)'
              } : {
                color: 'var(--text-slate-600)'
              }}>
            <DollarSign className="w-5 h-5" />
            <span className="font-semibold">Driver Payroll</span>
            {currentPayrollNetPay !== null && currentPayrollNetPay !== undefined &&
              <Badge variant="secondary" className="ml-auto justify-center w-auto px-2 rounded-[10px]" style={{ background: 'var(--bg-slate-200)', color: 'var(--text-slate-600)' }}>
                ${currentPayrollNetPay.toFixed(2)}
              </Badge>
              }
            </Link>
            }

      {(userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher') || userHasRole(currentUser, 'driver')) &&
            <Link
              to={constructUrlWithParams(createPageUrl("DeliveryMetrics"))}
              onClick={() => setSidebarOpen(false)}
              className={`px-4 rounded-xl flex items-center gap-2 transition-all duration-200 py-0 ${
              currentPageName === 'DeliveryMetrics' ?
              'shadow-sm' :
              'hover:opacity-80'}`
              }
              style={currentPageName === 'DeliveryMetrics' ? {
                background: 'var(--bg-slate-100)',
                color: 'var(--text-slate-900)'
              } : {
                color: 'var(--text-slate-600)'
              }}>
          <BarChart3 className="w-5 h-5" />
          <span className="font-semibold">Route Metrics</span>
        </Link>
            }

      {/* Documents — visible to all roles */}
      {(userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher') || userHasRole(currentUser, 'driver')) &&
            <Link
              to={createPageUrl('Documents')}
              onClick={() => setSidebarOpen(false)}
              className={`px-4 rounded-xl flex items-center gap-2 transition-all duration-200 py-0 ${
              currentPageName === 'Documents' ?
              'shadow-sm' :
              'hover:opacity-80'}`
              }
              style={currentPageName === 'Documents' ? {
                background: 'var(--bg-slate-100)',
                color: 'var(--text-slate-900)'
              } : {
                color: 'var(--text-slate-600)'
              }}>
          <FolderLock className="w-5 h-5" />
          <span className="font-semibold">Documents</span>
          {userHasRole(currentUser, 'dispatcher') && !userHasRole(currentUser, 'admin') ? (
            <div className="ml-auto flex items-center gap-1">
              {dispatcherDocBadges.pending > 0 && (
                <Badge className="justify-center rounded-[10px] px-2" style={{ background: '#fee2e2', color: '#991b1b' }}>
                  {dispatcherDocBadges.pending}
                </Badge>
              )}
              {dispatcherDocBadges.approvedUnviewed > 0 && (
                <Badge className="justify-center rounded-[10px] px-2" style={{ background: '#dcfce7', color: '#166534' }}>
                  {dispatcherDocBadges.approvedUnviewed}
                </Badge>
              )}
            </div>
          ) : pendingDocRequestCount > 0 && (
            <Badge className="ml-auto justify-center rounded-[10px] px-2" style={{ background: '#dcfce7', color: '#166534' }}>
              {pendingDocRequestCount}
            </Badge>
          )}
        </Link>
            }

      <div className="border-t mb-2 mt-1" style={{ borderColor: 'var(--border-slate-200)' }}></div>

      {(userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'driver')) &&
            <Link
              to={createPageUrl('Settings')}
              onClick={() => setSidebarOpen(false)}
              className={`px-4 rounded-xl flex items-center gap-2 transition-all duration-200 py-0.5 ${
              currentPageName === 'Settings' ?
              'shadow-sm' :
              'hover:opacity-80'}`
              }
              style={currentPageName === 'Settings' ? {
                background: 'var(--bg-slate-100)',
                color: 'var(--text-slate-900)'
              } : {
                color: 'var(--text-slate-600)'
              }}>
          <Settings className="w-5 h-5" />
          <span className="font-semibold">User Settings</span>
        </Link>
            }

      </div>

    {userHasRole(currentUser, 'admin') &&
          <AdminNavigationSection
            adminNavigationItems={adminNavigationItems}
            currentPageName={currentPageName}
            constructUrlWithParams={constructUrlWithParams}
            setSidebarOpen={setSidebarOpen} />
          }

    {currentPageName === 'Dashboard' &&
          <div className="mt-0">
          <div className="border-t mb-2" style={{ borderColor: 'var(--border-slate-200)' }}></div>
          <SidebarSectionLabel>Quick Stats</SidebarSectionLabel>
          <QuickStats
              currentUser={currentUser}
              storeIds={stores.filter((s) => s && s.city_id === globalFilters.getSelectedCityId()).map((s) => s.id)}
              isMobile={isMobile}
              screenWidth={screenWidth} />
            

        </div>
          }
  </div>

  <SidebarUserFooter
          currentUser={currentUser}
          users={users}
          appUsers={appUsers}
          unreadMessageCount={unreadMessageCount}
          onOpenMessaging={() => {setShowMessaging(true);setUnreadMessageCount(0);setSidebarOpen(false);}}
          onOpenInviteQR={() => {setShowInviteQRModal(true);setSidebarOpen(false);}}
          onOpenDriverChat={(driver) => {
            const otherUserId = driver.user_id || driver.id;
            const otherUserName = driver.user_name || 'Driver';
            const conversationId = [currentUser.id, otherUserId].sort().join('_');
            setInitialConversation({ conversationId, otherUserId, otherUserName });
            setShowMessaging(true);
            setUnreadMessageCount(0);
            setSidebarOpen(false);
          }}
          stores={stores}
          filteredDeliveries={filteredDeliveries} />

  </div>
    </>);

}