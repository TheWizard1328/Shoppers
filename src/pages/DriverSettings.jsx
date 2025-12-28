import React, { useState, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Truck, Search, Phone, MapPin, User, Circle } from 'lucide-react';
import { useAppData } from '../components/utils/AppDataContext';
import { formatPhoneNumber } from '../components/utils/phoneFormatter';
import { getDriverDisplayName } from '../components/utils/driverUtils';
import { sortUsers } from '../components/utils/sorting';

export default function DriverSettings() {
  const { users, appUsers, stores } = useAppData();
  const [searchQuery, setSearchQuery] = useState('');

  // Get all users with driver role
  const drivers = useMemo(() => {
    const driverUsers = users.filter(user => {
      if (!user || !user.app_roles || !Array.isArray(user.app_roles)) return false;
      return user.app_roles.includes('driver');
    });
    return sortUsers(driverUsers);
  }, [users]);

  // Filter drivers based on search
  const filteredDrivers = useMemo(() => {
    if (!searchQuery.trim()) return drivers;
    const query = searchQuery.toLowerCase();
    return drivers.filter(driver => {
      const name = getDriverDisplayName(driver)?.toLowerCase() || '';
      const phone = driver.phone?.toLowerCase() || '';
      const email = driver.email?.toLowerCase() || '';
      return name.includes(query) || phone.includes(query) || email.includes(query);
    });
  }, [drivers, searchQuery]);

  // Get store name helper
  const getStoreName = (storeId) => {
    const store = stores.find(s => s?.id === storeId);
    return store?.name || 'Unassigned';
  };

  // Get driver status color
  const getStatusColor = (status) => {
    switch (status) {
      case 'active': return 'bg-emerald-500';
      case 'inactive': return 'bg-slate-400';
      default: return 'bg-slate-400';
    }
  };

  // Get driver duty status info
  const getDriverDutyStatus = (driver) => {
    const appUser = appUsers.find(au => au?.user_id === driver.id);
    const driverStatus = appUser?.driver_status || driver.driver_status || 'off_duty';
    
    switch (driverStatus) {
      case 'on_duty': return { label: 'On Duty', color: 'bg-emerald-100 text-emerald-800' };
      case 'on_break': return { label: 'On Break', color: 'bg-yellow-100 text-yellow-800' };
      case 'online': return { label: 'Online', color: 'bg-blue-100 text-blue-800' };
      default: return { label: 'Off Duty', color: 'bg-slate-100 text-slate-600' };
    }
  };

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-3">
          <Truck className="w-7 h-7 text-emerald-600" />
          Driver Settings
        </h1>
        <p className="text-slate-600 mt-1">Manage drivers and configure driver app settings</p>
      </div>

      {/* Search */}
      <div className="mb-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <Input
            placeholder="Search drivers by name, phone, or email..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10"
          />
        </div>
      </div>

      {/* Driver Count */}
      <div className="mb-4 text-sm text-slate-600">
        {filteredDrivers.length} driver{filteredDrivers.length !== 1 ? 's' : ''} found
      </div>

      {/* Drivers List */}
      <div className="space-y-3">
        {filteredDrivers.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-slate-500">
              {searchQuery ? 'No drivers match your search' : 'No drivers found'}
            </CardContent>
          </Card>
        ) : (
          filteredDrivers.map(driver => {
            const dutyStatus = getDriverDutyStatus(driver);
            
            return (
              <Card key={driver.id} className="hover:shadow-md transition-shadow">
                <CardContent className="p-4">
                  <div className="flex items-center gap-4">
                    {/* Avatar */}
                    <div className={`w-12 h-12 rounded-full flex items-center justify-center flex-shrink-0 ${
                      driver.app_roles?.includes('admin') 
                        ? 'bg-gradient-to-br from-blue-500 to-blue-600'
                        : driver.app_roles?.includes('dispatcher')
                          ? 'bg-gradient-to-br from-red-500 to-red-600'
                          : 'bg-gradient-to-br from-emerald-500 to-emerald-600'
                    }`}>
                      <span className="text-white font-bold text-lg">
                        {(getDriverDisplayName(driver) || 'D')?.charAt(0).toUpperCase()}
                      </span>
                    </div>

                    {/* Driver Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="font-semibold text-slate-900 truncate">
                          {getDriverDisplayName(driver)}
                        </h3>
                        <Circle className={`w-2 h-2 ${getStatusColor(driver.status)}`} fill="currentColor" />
                        <Badge className={`text-xs ${dutyStatus.color}`}>
                          {dutyStatus.label}
                        </Badge>
                      </div>
                      
                      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1 text-sm text-slate-600">
                        {driver.phone && (
                          <div className="flex items-center gap-1">
                            <Phone className="w-3.5 h-3.5" />
                            <a href={`tel:${driver.phone}`} className="hover:text-slate-900">
                              {formatPhoneNumber(driver.phone)}
                            </a>
                          </div>
                        )}
                        {driver.email && (
                          <div className="flex items-center gap-1">
                            <User className="w-3.5 h-3.5" />
                            <span className="truncate">{driver.email}</span>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Right side - will add more settings later */}
                    <div className="flex-shrink-0">
                      <Badge variant="outline" className="text-xs">
                        #{driver.sort_order || '—'}
                      </Badge>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })
        )}
      </div>
    </div>
  );
}