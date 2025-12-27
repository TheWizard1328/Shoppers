import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Clock, Package, CheckCircle, XCircle, Truck } from "lucide-react";

export default function AdminInProgressList({ deliveries = [], patients = [], isLoading }) {
  if (isLoading) {
    return (
      <Card className="bg-white border-slate-200 shadow-sm">
        <CardHeader>
          <CardTitle>In Progress Deliveries</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {Array(3).fill(0).map((_, i) => (
              <div key={i} className="animate-pulse flex items-center gap-3">
                <div className="w-8 h-8 bg-slate-200 rounded-full"></div>
                <div className="flex-1 space-y-1">
                  <div className="h-3 bg-slate-200 rounded w-3/4"></div>
                  <div className="h-2 bg-slate-200 rounded w-1/2"></div>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  // Filter to in-progress deliveries only
  const inProgressDeliveries = (deliveries || []).filter(d => 
    d && ['pending', 'picked_up', 'in_transit'].includes(d.status)
  );

  const getPatient = (patientId) => {
    return (patients || []).find(p => p && p.id === patientId);
  };

  const getStatusIcon = (status) => {
    switch (status) {
      case 'picked_up': return <Package className="w-4 h-4 text-blue-500" />;
      case 'in_transit': return <Truck className="w-4 h-4 text-yellow-500" />;
      default: return <Clock className="w-4 h-4 text-slate-500" />;
    }
  };

  const getStatusColor = (status) => {
    switch (status) {
      case 'picked_up': return 'bg-blue-100 text-blue-800';
      case 'in_transit': return 'bg-yellow-100 text-yellow-800';
      case 'pending': return 'bg-slate-100 text-slate-800';
      default: return 'bg-slate-100 text-slate-800';
    }
  };

  return (
    <Card className="bg-white border-slate-200 shadow-sm">
      <CardHeader>
        <CardTitle className="text-lg font-semibold text-slate-900">
          In Progress Deliveries
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4 max-h-[400px] overflow-y-auto">
          {inProgressDeliveries.length === 0 ? (
            <p className="text-slate-500 text-center py-4">No deliveries in progress</p>
          ) : (
            inProgressDeliveries.map((delivery) => {
              if (!delivery) return null;
              
              const patient = getPatient(delivery.patient_id);
              return (
                <div key={delivery.id} className="flex items-center gap-3 p-3 rounded-lg hover:bg-slate-50 transition-colors">
                  <div className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center">
                    {getStatusIcon(delivery.status)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-slate-900 truncate">
                      {patient?.full_name || 'Unknown Patient'}
                    </p>
                    <p className="text-xs text-slate-500 truncate">
                      {delivery.driver_name || 'No driver assigned'}
                    </p>
                    <p className="text-xs text-slate-400">
                      {delivery.prescription_details || 'No details'}
                    </p>
                  </div>
                  <Badge className={`text-xs ${getStatusColor(delivery.status)}`}>
                    {delivery.status ? delivery.status.replace('_', ' ') : 'unknown'}
                  </Badge>
                </div>
              );
            })
          )}
        </div>
      </CardContent>
    </Card>
  );
}