import React, { useState, useMemo, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Truck, Search, Phone, MapPin, User, Circle, RefreshCw, Edit, Navigation, Building2 } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAppData } from '../components/utils/AppDataContext';
import { useUser } from '../components/utils/UserContext';
import { formatPhoneNumber } from '../components/utils/phoneFormatter';
import { getDriverDisplayName } from '../components/utils/driverUtils';
import { sortUsers } from '../components/utils/sorting';
import { base44 } from '@/api/base44Client';
import DriverEditForm from '../components/drivers/DriverEditForm';
import SmartRefreshIndicator from '../components/layout/SmartRefreshIndicator';
import { globalFilters } from '../components/utils/globalFilters';
import { getData } from '../components/utils/dataManager';
import { isMobileDevice } from '../components/utils/deviceUtils';
import { subscribeMutations } from '../components/utils/entityMutations';

export default function DriverSettings() {
  const { users, appUsers, stores, cities = [], refreshData } = useAppData();
  const { currentUser } = useUser();
  const [searchQuery, setSearchQuery] = useState('');
  const [freshAppUsers, setFreshAppUsers] = useState([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [editingDriver, setEditingDriver] = useState(null);
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
        // Refresh data on any AppUser change
        await fetchFreshData();
      }
    });

    // Only refresh on manual action or long intervals to avoid rate limits
    const interval = setInterval(fetchFreshData, 60000); // Refresh every 60 seconds max

    return () => {
      clearInterval(interval);
      unsubscribeMutations();
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

    // Non-admins only see active drivers
    if (!currentUser?.app_roles?.includes('admin')) {
      result = result.filter((driver) => driver.status === 'active');
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
          <SmartRefreshIndicator inline={true} />
          <Truck className="w-7 h-7 text-emerald-600" />
          Driver Settings
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
        {sortedCities.length > 0 &&
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
          <div className={`grid gap-3 ${isAdmin ? '[grid-template-columns:repeat(auto-fit,minmax(360px,1fr))]' : '[grid-template-columns:repeat(auto-fill,minmax(240px,1fr))]'}`}>
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

              if (!isAdmin) {
                const isMobile = isMobileDevice();
                // Compact card for drivers/dispatchers
                const cardContent =
                <CardContent className="p-3">
                    <div className="flex items-center gap-3">
                      {/* Avatar */}
                      <div className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ${avatarColor}`}>
                        <span className="text-white font-bold text-sm">
                          {(getDriverDisplayName(driver) || 'D')?.charAt(0).toUpperCase()}
                        </span>
                      </div>
                      {/* Info */}
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-sm truncate" style={{ color: 'var(--text-slate-900)' }}>
                          {getDriverDisplayName(driver)}
                        </p>
                        <div className="flex items-center gap-1 flex-wrap mt-0.5">
                          <Badge className={`text-xs py-0 h-4 ${dutyStatus.color}`}>{dutyStatus.label}</Badge>
                          {gpsLabel &&
                        <Badge className={`text-xs py-0 h-4 gap-0.5 ${gpsLabel.isRecent ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-700'}`}>
                              <Navigation className="w-2.5 h-2.5" />
                              {gpsLabel.label}
                            </Badge>
                        }
                        </div>
                        {driver.phone &&
                      <div className="flex items-center gap-1 mt-1 text-xs" style={{ color: 'var(--text-slate-500)' }}>
                            <Phone className="w-3 h-3" />
                            {formatPhoneNumber(driver.phone)}
                          </div>
                      }
                      </div>
                    </div>
                  </CardContent>;


                return driver.phone ?
                <a key={driver.id} href={`tel:${driver.phone}`} className="block">
                    <Card className="rounded-xl border shadow hover:shadow-md transition-shadow active:opacity-70" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
                      {cardContent}
                    </Card>
                  </a> :

                <Card key={driver.id} className="rounded-xl border shadow hover:shadow-md transition-shadow" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
                    {cardContent}
                  </Card>;

              }

              // Full card for admins
              return (
                <Card key={driver.id} className="rounded-xl border bg-card text-card-foreground shadow hover:shadow-md transition-shadow min-h-[210px] h-full min-w-[400px] max-w-[500px]" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
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
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3 className="font-semibold truncate" style={{ color: 'var(--text-slate-900)' }}>
                            {getDriverDisplayName(driver)}
                          </h3>
                          <Badge className={`text-xs ${driver.status === 'active' ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-700'}`}>
                            {driver.status === 'active' ? 'Active' : 'Inactive'}
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
                          {driver.email &&
                          <div className="flex items-center gap-1 truncate">
                              <User className="w-3.5 h-3.5 flex-shrink-0" />
                              <span className="truncate text-xs">{driver.email}</span>
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
    </div>);

}