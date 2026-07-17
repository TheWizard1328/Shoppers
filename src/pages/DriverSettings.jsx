import React, { useState, useMemo, useEffect } from 'react';
import { useDevice } from '@/components/utils/DeviceContext';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Truck, Search, Phone, MapPin, User, Circle, RefreshCw, Edit, Navigation, Building2, FileText, ShieldCheck } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAppData } from '../components/utils/AppDataContext';
import { useUser } from '../components/utils/UserContext';
import { formatPhoneNumber } from '../components/utils/phoneFormatter';
import { getDriverDisplayName } from '../components/utils/driverUtils';
import { sortUsers } from '../components/utils/sorting';
import { base44 } from '@/api/base44Client';
import DriverEditForm from '../components/drivers/DriverEditForm';
import DriverDetailSheet from '../components/drivers/DriverDetailSheet';
import SmartRefreshIndicator from '../components/layout/SmartRefreshIndicator';
import { globalFilters } from '../components/utils/globalFilters';
import { getData } from '../components/utils/dataManager';
import { subscribeMutations } from '../components/utils/entityMutations';
import { calculateHaversineDistance } from '../components/utils/distanceCalculator';

export default function DriverSettings() {
  const { users, appUsers, stores, cities = [], refreshData } = useAppData();
  const { currentUser } = useUser();
  const { isMobile } = useDevice();
  const [searchQuery, setSearchQuery] = useState('');
  const [freshAppUsers, setFreshAppUsers] = useState([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [editingDriver, setEditingDriver] = useState(null);
  const [selectedDriver, setSelectedDriver] = useState(null);
  const [activeDocRequests, setActiveDocRequests] = useState(new Set()); // driver_ids with active approved requests
  const [userEmails, setUserEmails] = useState({});
  let selectedCityId = globalFilters.getSelectedCityId();

  // Default to user's assigned city if not set
  useEffect(() => {
    if (currentUser && (!selectedCityId || selectedCityId === 'waiting-for-selection')) {
      const userCity = currentUser.city_id || Array.isArray(currentUser.city_ids) && currentUser.city_ids[0];
      if (userCity) {
        globalFilters.setSelectedCityId(userCity);
      }
    }
  }, [currentUser]);

  // Get fresh selected city after potential update
  selectedCityId = globalFilters.getSelectedCityId();

  const sortedCities = useMemo(() => {
    return [...cities].sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity));
  }, [cities]);

  // Fetch fresh AppUser data AND all drivers on mount
  useEffect(() => {
    const fetchFreshData = async () => {
      try {
        console.log('🔄 [DriverSettings] Refreshing AppUser and Driver data...');
        const freshAppData = await getData('AppUser', '-updated_date', null, true); // Force refresh
        setFreshAppUsers(freshAppData || []);
        console.log(`✅ [DriverSettings] Loaded ${freshAppData?.length || 0} AppUsers`);

        // Also fetch User records (built-in auth users) to get emails for all drivers
        const userRecords = await base44.entities.User.list();
        const emailMap = {};
        (Array.isArray(userRecords) ? userRecords : []).forEach((u) => {
          if (u?.id && u?.email) emailMap[u.id] = u.email;
        });
        setUserEmails(emailMap);
      } catch (error) {
        console.warn('Failed to fetch fresh AppUser data:', error);
      }
    };

    // Fetch immediately on mount
    fetchFreshData();

    // Subscribe to AppUser mutations for real-time updates
    const unsubscribeMutations = subscribeMutations(async (mutation) => {
      if (mutation.entity === 'AppUser') {
        console.log('🔔 [DriverSettings] AppUser mutation received:', mutation.type, mutation.id);
        await fetchFreshData();
      }
    });

    // Subscribe to live location/heartbeat broadcasts from layout's smart refresh
    const handleDriverLocationsUpdated = (event) => {
      const updatedAppUsers = event?.detail?.appUsers;
      if (!Array.isArray(updatedAppUsers) || updatedAppUsers.length === 0) return;
      setFreshAppUsers((prev) => prev.map((u) => {
        const updated = updatedAppUsers.find((au) => au.id === u.id);
        return updated ? { ...u, ...updated } : u;
      }));
    };
    window.addEventListener('driverLocationsUpdated', handleDriverLocationsUpdated);

    // Only refresh on manual action or long intervals to avoid rate limits
    // Fetch active doc access requests (for dispatcher badge)
    const fetchDocRequests = async () => {
      try {
        if (!currentUser?.app_roles?.includes('dispatcher')) return;
        const me = await base44.auth.me();
        if (!me) return;
        const approved = await base44.entities.DocAccessRequest.list({
          filter: { requester_id: me.id, status: 'approved' },
          limit: 50
        });
        const now = new Date();
        const active = new Set();
        for (const r of approved || []) {
          if (r.expires_at && now > new Date(r.expires_at)) continue;
          if (r.first_viewed_at) {
            const viewTime = new Date(r.first_viewed_at);
            if (now > new Date(viewTime.getTime() + 30 * 60 * 1000)) continue;
          }
          active.add(r.driver_id);
        }
        setActiveDocRequests(active);
      } catch (e) {
        console.warn('Failed to fetch doc requests:', e);
      }
    };
    fetchDocRequests();
    const docInterval = setInterval(fetchDocRequests, 60000);

    const interval = setInterval(fetchFreshData, 60000); // Refresh every 60 seconds max

    return () => {
      clearInterval(interval);
      clearInterval(docInterval);
      unsubscribeMutations();
      window.removeEventListener('driverLocationsUpdated', handleDriverLocationsUpdated);
    };
  }, []); // Run once on mount

  // Merge fresh AppUser data with context appUsers
  const mergedAppUsers = useMemo(() => {
    if (freshAppUsers.length > 0) return freshAppUsers;
    return appUsers;
  }, [freshAppUsers, appUsers]);

  // Get all users with driver role - show ALL drivers regardless of status (deduplicated by ID)
  const drivers = useMemo(() => {
    const seen = new Set();
    const driverUsers = users.filter((user) => {
      if (!user || !user.app_roles || !Array.isArray(user.app_roles)) return false;
      if (seen.has(user.id)) return false; // Skip duplicates
      seen.add(user.id);
      // Show ALL drivers regardless of duty status or location sharing
      return user.app_roles.includes('driver');
    });
    return sortUsers(driverUsers);
  }, [users]);

  // Filter drivers based on search and city
  const filteredDrivers = useMemo(() => {
    let result = drivers;

    // Non-admins (drivers + dispatchers) only see active drivers
    const isDispatcher = currentUser?.app_roles?.includes('dispatcher') && !currentUser?.app_roles?.includes('admin');
    if (!currentUser?.app_roles?.includes('admin') || isDispatcher) {
      result = result.filter((driver) => {
        const appUser = mergedAppUsers.find((au) => au?.user_id === driver.id);
        const status = appUser?.status ?? driver.status;
        return status === 'active';
      });
    }

    // Filter by city (admins see all)
    if (!currentUser?.app_roles?.includes('admin') && selectedCityId && selectedCityId !== 'waiting-for-selection') {
      result = result.filter((driver) => {
        const cityIds = Array.isArray(driver.city_ids) ? driver.city_ids : driver.city_id ? [driver.city_id] : [];
        return cityIds.includes(selectedCityId);
      });
    }

    // Filter by search query
    if (!searchQuery.trim()) return result;
    const query = searchQuery.toLowerCase();
    return result.filter((driver) => {
      const name = getDriverDisplayName(driver)?.toLowerCase() || '';
      const phone = driver.phone?.toLowerCase() || '';
      const email = driver.email?.toLowerCase() || '';
      return name.includes(query) || phone.includes(query) || email.includes(query);
    });
  }, [drivers, searchQuery, selectedCityId]);

  // Get store name helper
  const getStoreName = (storeId) => {
    const store = stores.find((s) => s?.id === storeId);
    return store?.name || 'Unassigned';
  };

  // Get driver status color
  const getStatusColor = (status) => {
    switch (status) {
      case 'active':return 'bg-emerald-500';
      case 'inactive':return 'bg-slate-400';
      default:return 'bg-slate-400';
    }
  };

  // Get driver duty status info - use fresh AppUser data for accurate status
  const getDriverDutyStatus = (driver) => {
    // CRITICAL: Use mergedAppUsers (fresh data) for accurate driver_status
    const appUser = mergedAppUsers.find((au) => au?.user_id === driver.id);
    const driverStatus = appUser?.driver_status ?? driver.driver_status ?? 'off_duty';

    switch (driverStatus) {
      case 'on_duty':return { label: 'On Duty', color: 'bg-emerald-100 text-emerald-800' };
      case 'on_break':return { label: 'On Break', color: 'bg-orange-100 text-orange-800' };
      case 'online':return { label: 'Online', color: 'bg-blue-100 text-blue-800' };
      default:return { label: 'Off Duty', color: 'bg-red-100 text-red-800' };
    }
  };

  // Calculate crow-flies distance from the dispatcher's store(s) to each driver.
  // On duty → use driver's current GPS location (green badge). Off duty → use home location (red badge).
  const dispatcherStoreIds = currentUser?.store_ids || [];
  const dispatcherStores = stores.filter((s) => dispatcherStoreIds.includes(s?.id) && s?.latitude && s?.longitude);

  const getDriverDistanceToStore = (driver, latestAppUser, isOnDuty) => {
    let driverLat, driverLng;
    if (isOnDuty) {
      driverLat = latestAppUser?.current_latitude ?? driver.current_latitude;
      driverLng = latestAppUser?.current_longitude ?? driver.current_longitude;
    } else {
      driverLat = latestAppUser?.home_latitude ?? driver.home_latitude;
      driverLng = latestAppUser?.home_longitude ?? driver.home_longitude;
    }
    if (!driverLat || !driverLng) return null;

    // Use dispatcher's assigned stores as origin; fall back to all stores for admins
    const originStores = dispatcherStores.length > 0 ? dispatcherStores : stores.filter((s) => s?.latitude && s?.longitude);
    if (!originStores.length) return null;

    let minDist = Infinity;
    originStores.forEach((store) => {
      const dist = calculateHaversineDistance(store.latitude, store.longitude, driverLat, driverLng);
      if (dist < minDist) minDist = dist;
    });

    if (minDist === Infinity) return null;
    return minDist < 1000 ?
    `${Math.round(minDist)}m` :
    `${(minDist / 1000).toFixed(1)}km`;
  };

  const handleSaveDriver = async (userId, updates) => {
    try {
      // Find the AppUser record by user_id (not the User's id)
      const appUser = mergedAppUsers.find((au) => au?.user_id === userId);
      if (!appUser) {
        throw new Error('AppUser record not found for this driver');
      }

      // Update using the AppUser's actual ID
      await base44.entities.AppUser.update(appUser.id, updates);

      // Refresh data
      const freshData = await base44.entities.AppUser.list();
      setFreshAppUsers(freshData || []);

      if (refreshData) {
        await refreshData();
      }

      setEditingDriver(null);
    } catch (error) {
      throw error;
    }
  };

  return (
    <div className="p-6 max-w-auto mx-auto h-full overflow-y-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold flex items-center gap-3" style={{ color: 'var(--text-slate-900)' }}>
          <Truck className="w-7 h-7 text-emerald-600" />
          Driver Settings
          <SmartRefreshIndicator inline={true} />
        </h1>
        <p className="mt-1" style={{ color: 'var(--text-slate-600)' }}>Manage drivers and configure driver app settings</p>
      </div>

      {/* Search and City Selector */}
      <div className="mb-4 flex gap-3 items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <Input
            placeholder="Search drivers by name, phone, or email..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10" />
        </div>
        {sortedCities.length > 0 && currentUser?.app_roles?.includes('admin') &&
        <Select
          value={selectedCityId}
          onValueChange={(cityId) => globalFilters.setSelectedCityId(cityId)}>
          
            <SelectTrigger className="w-[150px] h-10" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
              <div className="flex items-center gap-2">
                <Building2 className="w-4 h-4" />
                <SelectValue placeholder="City" />
              </div>
            </SelectTrigger>
            <SelectContent style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
              {sortedCities.map((city) =>
            <SelectItem key={city.id} value={city.id} style={{ color: 'var(--text-slate-900)' }}>
                  {city.name}
                </SelectItem>
            )}
            </SelectContent>
          </Select>
        }
      </div>

      {/* Driver Count */}
      <div className="mb-4 text-sm" style={{ color: 'var(--text-slate-600)' }}>
        {filteredDrivers.length} driver{filteredDrivers.length !== 1 ? 's' : ''} found
      </div>

      {/* Drivers List */}
      {(() => {
        const isAdmin = currentUser?.app_roles?.includes('admin');
        return (
          <div className={`grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(275px,1fr))] ${isAdmin ? '[grid-template-columns:repeat(auto-fit,minmax(360px,1fr))]' : ""}`}>
            {filteredDrivers.length === 0 ?
            <Card className="col-span-full" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
                <CardContent className="py-8 text-center" style={{ color: 'var(--text-slate-500)' }}>
                  {searchQuery ? 'No drivers match your search' : 'No drivers found'}
                </CardContent>
              </Card> :

            filteredDrivers.map((driver) => {
              const latestAppUser = mergedAppUsers.find((au) => au?.user_id === driver.id);
              const dutyStatus = getDriverDutyStatus(driver);
              const avatarColor = driver.app_roles?.includes('admin') ?
              'bg-gradient-to-br from-blue-500 to-blue-600' :
              driver.app_roles?.includes('dispatcher') ?
              'bg-gradient-to-br from-red-500 to-red-600' :
              'bg-gradient-to-br from-emerald-500 to-emerald-600';

              const gpsLabel = (() => {
                if (!latestAppUser?.location_updated_at || dutyStatus.label === 'Off Duty') return null;
                const diffMins = Math.floor((Date.now() - new Date(latestAppUser.location_updated_at).getTime()) / 60000);
                const isRecent = diffMins < 5;
                const label = diffMins < 1 ? '<1m' : diffMins > 60 ? `>${Math.floor(diffMins / 60)}h` : `${diffMins}m`;
                return { label, isRecent };
              })();

              const isOnDuty = dutyStatus.label === 'On Duty' || dutyStatus.label === 'On Break' || dutyStatus.label === 'Online';
              const distToStore = getDriverDistanceToStore(driver, latestAppUser, isOnDuty);
              const distBadgeClass = isOnDuty ?
              'bg-emerald-100 text-emerald-800' :
              'bg-red-100 text-red-700';

              if (!isAdmin) {
                // Compact card: 3-column grid layout
                return (
                  <Card
                    key={driver.id}
                    onClick={() => setSelectedDriver(driver)}
                    className="rounded-xl border shadow hover:shadow-md transition-shadow cursor-pointer active:opacity-70"
                    style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
                    
                    <CardContent className="p-3">
                      {/* 3-column grid: Avatar | Name+Phone | Badges */}
                      <div className="grid grid-cols-[auto_1fr_auto] gap-x-3 gap-y-0.5 items-start">
                        {/* Col 1: Avatar — spans 2 rows */}
                        <div className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 row-span-2 self-center ${avatarColor}`}>
                          <span className="text-white font-bold text-sm">
                            {(getDriverDisplayName(driver) || 'D')?.charAt(0).toUpperCase()}
                          </span>
                        </div>

                        {/* Col 2 Row 1: Name */}
                        <p className="font-semibold text-sm truncate leading-tight pt-0.5" style={{ color: 'var(--text-slate-900)' }}>
                          {getDriverDisplayName(driver)}
                        </p>

                        {/* Col 3 Row 1: Duty status badge — fixed width */}
                        <div className="flex justify-center w-20">
                          <Badge className={`text-xs py-0 h-5 w-full justify-center ${dutyStatus.color}`}>{dutyStatus.label}</Badge>
                        </div>

                        {/* Col 2 Row 2: Phone (non-tappable) */}
                        <div className="flex items-center gap-1 text-xs" style={{ color: 'var(--text-slate-500)' }}>
                          {driver.phone ?
                          <>
                              <Phone className="w-3 h-3 flex-shrink-0" />
                              <span>{formatPhoneNumber(driver.phone)}</span>
                            </> :

                          <span className="opacity-0 select-none">—</span>
                          }
                        </div>

                        {/* Col 3 Row 2: GPS + Distance badges — fixed width matching row 1 */}
                        <div className="flex items-center justify-center gap-1 w-20">
                          




                          
                          {distToStore &&
                          <Badge className={`text-xs py-0 h-5 gap-0.5 flex-1 justify-center ${distBadgeClass}`}>
                              <MapPin className="w-2.5 h-2.5" />
                              {distToStore}
                            </Badge>
                          }
                        </div>

                        {/* Row 3: spans all 3 cols — fully centered doc button */}
                        <div className="col-span-3 flex items-center justify-center pt-1.5 border-t border-slate-100/50 mt-1">
                          {currentUser?.app_roles?.includes('dispatcher') && (
                          activeDocRequests.has(driver.id) ?
                          <Badge className="h-6 px-2 text-[10px] rounded-full gap-1 bg-emerald-50 text-emerald-700 border border-emerald-200">
                                <ShieldCheck className="w-2.5 h-2.5" />
                                Docs Ready
                              </Badge> :

                          <Button
                            variant="outline"
                            size="sm"
                            onClick={(e) => {e.stopPropagation();setSelectedDriver(driver);}}
                            className="h-6 px-2 text-[10px] rounded-full flex items-center gap-1 bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200">
                            
                                <FileText className="w-2.5 h-2.5" />
                                Request Docs
                              </Button>)

                          }
                          {!currentUser?.app_roles?.includes('dispatcher') && <div className="h-6" />}
                        </div>
                      </div>
                    </CardContent>
                  </Card>);

              }

              // Full card for admins
              return (
                <Card key={driver.id} className="rounded-xl border bg-card text-card-foreground shadow hover:shadow-md transition-shadow min-h-[210px] h-full w-full" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
                  <CardContent className="p-4 h-full">
                    <div className="flex items-start gap-4 h-full">
                      {/* Avatar */}
                      <div className={`w-12 h-12 rounded-full flex items-center justify-center flex-shrink-0 ${avatarColor}`}>
                        <span className="text-white font-bold text-lg">
                          {(getDriverDisplayName(driver) || 'D')?.charAt(0).toUpperCase()}
                        </span>
                      </div>

                      {/* Driver Info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2 flex-wrap min-w-0">
                            <h3 className="font-semibold truncate" style={{ color: 'var(--text-slate-900)' }}>
                              {getDriverDisplayName(driver)}
                            </h3>
                          </div>
                          {distToStore &&
                          <Badge className={`text-xs gap-1 flex-shrink-0 ${distBadgeClass}`}>
                              <MapPin className="w-3 h-3" />
                              {distToStore}
                            </Badge>
                          }
                        </div>
                        <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                          <Badge className={`text-xs ${(latestAppUser?.status ?? driver.status) === 'active' ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-700'}`}>
                            {(latestAppUser?.status ?? driver.status) === 'active' ? 'Active' : 'Inactive'}
                          </Badge>
                          <Badge className={`text-xs ${dutyStatus.color}`}>
                            {dutyStatus.label}
                          </Badge>
                          {gpsLabel &&
                          <Badge className={`text-xs gap-1 ${gpsLabel.isRecent ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-700'}`}>
                              <Navigation className="w-3 h-3" />
                              GPS: {gpsLabel.label}
                            </Badge>
                          }
                        </div>

                        <div className="flex flex-col gap-1 mt-1 text-sm" style={{ color: 'var(--text-slate-600)' }}>
                          {driver.phone &&
                          <div className="flex items-center gap-1">
                              <Phone className="w-3.5 h-3.5" />
                              <a href={`tel:${driver.phone}`} className="hover:opacity-80">
                                {formatPhoneNumber(driver.phone)}
                              </a>
                            </div>
                          }
                          {(driver.email || userEmails[driver.id]) &&
                          <div className="flex items-center gap-1 truncate">
                              <User className="w-3.5 h-3.5 flex-shrink-0" />
                              <span className="truncate text-xs">{driver.email || userEmails[driver.id]}</span>
                            </div>
                          }
                        </div>

                        {/* Pay rates display - admins only */}
                        {(latestAppUser?.pay_cycle_type || latestAppUser?.pay_rate_per_delivery > 0) &&
                        <div className="flex items-center gap-1.5 mt-1.5 text-xs flex-wrap" style={{ color: 'var(--text-slate-500)' }}>
                            {latestAppUser?.pay_cycle_type &&
                          <span className="capitalize">{latestAppUser.pay_cycle_type === 'biweekly' ? 'Bi-Weekly' : latestAppUser.pay_cycle_type === 'semimonthly' ? 'Semi-Monthly' : latestAppUser.pay_cycle_type}</span>
                          }
                            {latestAppUser?.pay_cycle_type && latestAppUser?.pay_rate_per_delivery > 0 && <span>•</span>}
                            {latestAppUser?.pay_rate_per_delivery > 0 &&
                          <span>${Number(latestAppUser.pay_rate_per_delivery).toFixed(2)}/delivery</span>
                          }
                          </div>
                        }
                        {(latestAppUser?.extra_km_rate > 0 || latestAppUser?.extra_km_limit > 0 || latestAppUser?.oversized_item_rate > 0) &&
                        <div className="flex items-center gap-1.5 mt-0.5 text-xs flex-wrap" style={{ color: 'var(--text-slate-500)' }}>
                            {latestAppUser?.extra_km_rate > 0 && <span>${Number(latestAppUser.extra_km_rate).toFixed(2)}/km</span>}
                            {latestAppUser?.extra_km_rate > 0 && latestAppUser?.extra_km_limit > 0 && <span>•</span>}
                            {latestAppUser?.extra_km_limit > 0 && <span>{Number(latestAppUser.extra_km_limit).toFixed(2)}km limit</span>}
                            {(latestAppUser?.extra_km_rate > 0 || latestAppUser?.extra_km_limit > 0) && latestAppUser?.oversized_item_rate > 0 && <span>•</span>}
                            {latestAppUser?.oversized_item_rate > 0 && <span>${Number(latestAppUser.oversized_item_rate).toFixed(2)}/oversized</span>}
                          </div>
                        }
                      </div>

                      {/* Actions */}
                      <div className="flex flex-col gap-2 items-end self-start">
                        <Button variant="outline" size="sm" onClick={() => setEditingDriver(driver)} className="h-8 gap-1">
                          <Edit className="w-3.5 h-3.5" />
                          <span className="text-xs">Edit</span>
                        </Button>
                        <Badge variant="outline" className="text-xs" style={{ borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-600)' }}>
                          #{driver.sort_order || '—'}
                        </Badge>
                      </div>
                    </div>
                  </CardContent>
                </Card>);

            })
            }
          </div>);

      })()}
      
      {/* Edit Driver Form - admins only */}
       {currentUser?.app_roles?.includes('admin') && editingDriver && (() => {
        const latestAppUser = mergedAppUsers.find((au) => au?.user_id === editingDriver.id);
        const sourceDriver = latestAppUser || editingDriver;
        const mergedDriver = {
          ...editingDriver,
          ...latestAppUser,
          ...sourceDriver,
          id: editingDriver.id,
          user_id: editingDriver.id
        };
        return (
          <DriverEditForm
            driver={mergedDriver}
            onSave={async (updates) => {
              await handleSaveDriver(editingDriver.id, updates);
            }}
            onCancel={() => setEditingDriver(null)} />);

      })()
      }
      {selectedDriver &&
      <DriverDetailSheet
        driver={selectedDriver}
        currentUser={currentUser}
        onClose={() => setSelectedDriver(null)} />

      }
    </div>);

}