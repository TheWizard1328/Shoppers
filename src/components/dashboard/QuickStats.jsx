import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Clock, CheckCircle, AlertCircle, Users } from "lucide-react";
import { format } from "date-fns";

export default function QuickStats({ currentUser, deliveries = [], patients = [] }) {
  const userRole = currentUser?.user_role || currentUser?.role;

  // Get today's deliveries
  const today = format(new Date(), 'yyyy-MM-dd');

  // Calculate stats based on user role
  let visibleDeliveries = deliveries;
  if (userRole === 'dispatcher') {
    const dispatcherStoreIds = currentUser?.store_ids || [];
    const dispatcherPatientIds = patients
      .filter(p => dispatcherStoreIds.includes(p.store_id))
      .map(p => p.id);
    visibleDeliveries = deliveries.filter(d => dispatcherPatientIds.includes(d.patient_id));
  } else if (userRole === 'driver') {
    visibleDeliveries = deliveries.filter(d => d.driver_name === currentUser?.full_name);
  }

  const todayVisibleDeliveries = visibleDeliveries.filter(d => d.delivery_date === today);

  // Calculate pickup ETA for pending deliveries
  const pendingDeliveries = todayVisibleDeliveries.filter(d => d.status === 'pending');
  const hasPickupETA = pendingDeliveries.length > 0;

  // Calculate stats
  const completed = todayVisibleDeliveries.filter(d => d.status === 'delivered').length;
  const failed = todayVisibleDeliveries.filter(d => d.status === 'failed').length;
  const pending = pendingDeliveries.length;
  const totalPatients = patients.length;

  const statsToShow = [];
  if (pending > 0) statsToShow.push({ label: 'Pending', value: pending, icon: Clock, color: 'yellow' });
  if (completed > 0) statsToShow.push({ label: 'Completed', value: completed, icon: CheckCircle, color: 'green' });
  if (failed > 0) statsToShow.push({ label: 'Failed', value: failed, icon: AlertCircle, color: 'red' });

  const iconClasses = {
    yellow: 'text-yellow-600',
    green: 'text-green-600',
    red: 'text-red-600',
    blue: 'text-blue-600'
  };
  const badgeClasses = {
    yellow: 'bg-yellow-100 text-yellow-800 hover:bg-yellow-100',
    green: 'bg-green-100 text-green-800 hover:bg-green-100',
    red: 'bg-red-100 text-red-800 hover:bg-red-100',
    blue: 'bg-blue-100 text-blue-800 hover:bg-blue-100'
  };

  return (
    <div className="grid grid-cols-2 lg:grid-cols-1 gap-4">
      {/* Pickup ETA for pending deliveries */}
      {hasPickupETA && (
        <Card className="bg-white border-slate-200 shadow-sm">
          <CardContent className="p-4">
            <div className="flex items-center justify-between text-sm">
              <div className="flex items-center gap-2">
                <Clock className="w-4 h-4 text-orange-600" />
                <span className="text-slate-600 font-medium">Pickup ETA</span>
              </div>
              <Badge className="bg-orange-100 text-orange-800 hover:bg-orange-100">
                15 min
              </Badge>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Stats for Dispatcher/Driver */}
      {(userRole === 'dispatcher' || userRole === 'driver') && statsToShow.map(stat => (
        <Card key={stat.label} className="bg-white border-slate-200 shadow-sm">
          <CardContent className="p-4">
            <div className="flex items-center justify-between text-sm">
              <div className="flex items-center gap-2">
                {stat.icon && <stat.icon className={`w-4 h-4 ${iconClasses[stat.color]}`} />}
                <span className="text-slate-600 font-medium">{stat.label}</span>
              </div>
              <Badge className={badgeClasses[stat.color]}>
                {stat.value}
              </Badge>
            </div>
          </CardContent>
        </Card>
      ))}

      {/* Stats for Admin */}
      {userRole === 'admin' && (
        <>
          {statsToShow.map(stat => (
            <Card key={stat.label} className="bg-white border-slate-200 shadow-sm">
              <CardContent className="p-4">
                <div className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2">
                    {stat.icon && <stat.icon className={`w-4 h-4 ${iconClasses[stat.color]}`} />}
                    <span className="text-slate-600 font-medium">{stat.label}</span>
                  </div>
                  <Badge className={badgeClasses[stat.color]}>
                    {stat.value}
                  </Badge>
                </div>
              </CardContent>
            </Card>
          ))}
          <Card className="bg-white border-slate-200 shadow-sm">
            <CardContent className="p-4">
              <div className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-2">
                  <Users className="w-4 h-4 text-blue-600" />
                  <span className="text-slate-600 font-medium">Total Patients</span>
                </div>
                <Badge className="bg-blue-100 text-blue-800 hover:bg-blue-100">
                  {totalPatients}
                </Badge>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}