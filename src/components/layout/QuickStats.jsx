import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { Badge } from "@/components/ui/badge";
import { 
  Package, 
  Users, 
  MapPin,
  ChevronDown,
  ChevronUp
} from "lucide-react";
import { format } from "date-fns";

export default function QuickStats({ currentUser }) {
  const [patients, setPatients] = useState([]);
  const [deliveries, setDeliveries] = useState([]);
  const [stores, setStores] = useState([]);
  const [drivers, setDrivers] = useState([]);
  const [expandedStat, setExpandedStat] = useState(null);

  useEffect(() => {
    if (currentUser) {
      loadData();
    }
  }, [currentUser]);

  const loadData = async () => {
    try {
      const [patientsData, deliveriesData, storesData, appUsersData] = await Promise.all([
        base44.entities.Patient.list(),
        base44.entities.Delivery.list(),
        base44.entities.Store.list(),
        base44.entities.AppUser.list()
      ]);
      setPatients(patientsData);
      setDeliveries(deliveriesData);
      setStores(storesData);
      setDrivers(appUsersData.filter(u => u && u.app_roles && u.app_roles.includes('driver')));
    } catch (error) {
      console.error("Error loading stats data:", error);
    }
  };

  // CRITICAL: Add null check to prevent crashes during initialization
  if (!currentUser) {
    return null;
  }

  const todayDate = format(new Date(), 'yyyy-MM-dd');
  const todayDeliveries = deliveries.filter(d => d && d.delivery_date === todayDate);
  const activeDeliveries = todayDeliveries.filter(d => d && ['pending', 'in_transit'].includes(d.status));

  // Active deliveries by driver
  const activeDeliveriesByDriver = drivers.map(driver => {
    if (!driver) return null;
    const driverActiveDeliveries = activeDeliveries.filter(d => d && d.driver_name === driver.user_name);
    return {
      name: driver.user_name || driver.full_name || 'Unknown',
      count: driverActiveDeliveries.length
    };
  }).filter(d => d && d.count > 0);

  // Patients by store
  const patientsByStore = stores.map(store => {
    if (!store) return null;
    const storePatients = patients.filter(p => p && p.store_id === store.id);
    return {
      name: store.name,
      count: storePatients.length
    };
  }).filter(s => s && s.count > 0);

  // Active routes by driver (drivers with active deliveries today)
  const activeRoutesByDriver = drivers.map(driver => {
    if (!driver) return null;
    const driverTodayDeliveries = todayDeliveries.filter(d => d && d.driver_name === (driver.user_name || driver.full_name));
    const completed = driverTodayDeliveries.filter(d => d && d.status === 'completed').length;
    const failed = driverTodayDeliveries.filter(d => d && d.status === 'failed').length;
    const pending = driverTodayDeliveries.filter(d => d && ['pending', 'in_transit'].includes(d.status)).length;
    
    return {
      name: driver.user_name || driver.full_name || 'Unknown',
      completed,
      failed,
      pending,
      total: driverTodayDeliveries.length
    };
  }).filter(d => d && d.total > 0);

  const toggleExpanded = (statName) => {
    setExpandedStat(expandedStat === statName ? null : statName);
  };

  return (
    <div className="px-3 py-2 space-y-3">
      {/* Active Deliveries */}
      <div>
        <div 
          className="flex items-center justify-between text-sm cursor-pointer hover:bg-slate-50 p-2"
          onClick={() => toggleExpanded('activeDeliveries')}
        >
          <div className="flex items-center gap-2">
            <Package className="w-4 h-4 text-emerald-600" />
            <span className="text-slate-600 font-medium">Active Deliveries</span>
          </div>
          <div className="flex items-center gap-1">
            <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100">
              {activeDeliveries.length}
            </Badge>
            {expandedStat === 'activeDeliveries' ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </div>
        </div>
        
        {expandedStat === 'activeDeliveries' && (
          <div className="ml-6 mt-2 space-y-1">
            {activeDeliveriesByDriver.length > 0 ? (
              activeDeliveriesByDriver.map(driver => (
                <div key={driver.name} className="flex justify-between text-xs">
                  <span className="text-slate-600 truncate">{driver.name}</span>
                  <Badge variant="outline" className="text-xs">
                    {driver.count}
                  </Badge>
                </div>
              ))
            ) : (
              <div className="text-xs text-slate-500">No active deliveries</div>
            )}
          </div>
        )}
      </div>

      {/* Total Patients */}
      {currentUser && (currentUser?.role === 'admin' || (currentUser?.app_roles && currentUser.app_roles.includes('dispatcher'))) && (
        <div>
          <div 
            className="flex items-center justify-between text-sm cursor-pointer hover:bg-slate-50 p-2 rounded-lg"
            onClick={() => toggleExpanded('totalPatients')}
          >
            <div className="flex items-center gap-2">
              <Users className="w-4 h-4 text-blue-600" />
              <span className="text-slate-600 font-medium">Total Patients</span>
            </div>
            <div className="flex items-center gap-1">
              <Badge className="bg-blue-100 text-blue-800 hover:bg-blue-100">
                {patients.length}
              </Badge>
              {expandedStat === 'totalPatients' ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            </div>
          </div>
          
          {expandedStat === 'totalPatients' && (
            <div className="ml-6 mt-2 space-y-1">
              {patientsByStore.map(store => (
                <div key={store.name} className="flex justify-between text-xs">
                  <span className="text-slate-600 truncate">{store.name}</span>
                  <Badge variant="outline" className="text-xs">
                    {store.count}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Active Routes */}
      <div>
        <div 
          className="flex items-center justify-between text-sm cursor-pointer hover:bg-slate-50 p-2 rounded-lg"
          onClick={() => toggleExpanded('activeRoutes')}
        >
          <div className="flex items-center gap-2">
            <MapPin className="w-4 h-4 text-purple-600" />
            <span className="text-slate-600 font-medium">Active Routes</span>
          </div>
          <div className="flex items-center gap-1">
            <Badge className="bg-purple-100 text-purple-800 hover:bg-purple-100">
              {activeRoutesByDriver.length}
            </Badge>
            {expandedStat === 'activeRoutes' ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </div>
        </div>
        
        {expandedStat === 'activeRoutes' && (
          <div className="ml-6 mt-2 space-y-2">
            {activeRoutesByDriver.length > 0 ? (
              activeRoutesByDriver.map(driver => (
                <div key={driver.name} className="space-y-1">
                  <div className="text-xs font-medium text-slate-700 truncate">{driver.name}</div>
                  <div className="flex gap-1">
                    <Badge className="bg-green-100 text-green-800 text-xs">
                      {driver.completed}
                    </Badge>
                    <Badge className="bg-red-100 text-red-800 text-xs">
                      {driver.failed}
                    </Badge>
                    <Badge className="bg-blue-100 text-blue-800 text-xs">
                      {driver.pending}
                    </Badge>
                  </div>
                </div>
              ))
            ) : (
              <div className="text-xs text-slate-500">No active routes today</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}