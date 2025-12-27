import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Calendar, Clock, MapPin } from "lucide-react";
import { format, isToday, isTomorrow } from "date-fns";

export default function UpcomingDeliveries({ deliveries, patients, isLoading }) {
  const upcomingDeliveries = (deliveries || [])
    .filter(d => ['pending', 'in_transit'].includes(d.status))
    .sort((a, b) => new Date(a.delivery_date) - new Date(b.delivery_date))
    .slice(0, 5);

  const getPatient = (patientId) => {
    return (patients || []).find(p => p.id === patientId);
  };

  const getDateLabel = (dateString) => {
    const date = new Date(dateString);
    if (isToday(date)) return 'Today';
    if (isTomorrow(date)) return 'Tomorrow';
    return format(date, 'MMM d');
  };

  const getPriorityColor = (priority) => {
    switch (priority) {
      case 'urgent': return 'bg-red-100 text-red-800';
      case 'high': return 'bg-orange-100 text-orange-800';
      case 'normal': return 'bg-blue-100 text-blue-800';
      case 'low': return 'bg-gray-100 text-gray-800';
      default: return 'bg-blue-100 text-blue-800';
    }
  };

  if (isLoading) {
    return (
      <Card className="bg-white border-slate-200 shadow-sm">
        <CardHeader>
          <CardTitle>Upcoming Deliveries</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {Array(5).fill(0).map((_, i) => (
              <div key={i} className="animate-pulse p-3 rounded-lg border border-slate-100">
                <div className="flex justify-between items-start mb-2">
                  <div className="h-4 bg-slate-200 rounded w-1/2"></div>
                  <div className="h-5 bg-slate-200 rounded w-16"></div>
                </div>
                <div className="space-y-1">
                  <div className="h-3 bg-slate-200 rounded w-3/4"></div>
                  <div className="h-3 bg-slate-200 rounded w-1/2"></div>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="bg-white border-slate-200 shadow-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg font-semibold text-slate-900">
          <Calendar className="w-5 h-5 text-emerald-600" />
          Upcoming Deliveries
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {upcomingDeliveries.length === 0 ? (
            <p className="text-slate-500 text-center py-4">No upcoming deliveries</p>
          ) : (
            upcomingDeliveries.map((delivery) => {
              const patient = getPatient(delivery.patient_id);
              return (
                <div key={delivery.id} className="p-4 rounded-lg border border-slate-100 hover:border-slate-200 transition-colors">
                  <div className="flex justify-between items-start mb-2">
                    <h4 className="font-medium text-slate-900 truncate">
                      {patient?.full_name || 'Unknown Patient'}
                    </h4>
                    <Badge className={`text-xs ${getPriorityColor(delivery.priority)}`}>
                      {delivery.priority}
                    </Badge>
                  </div>
                  
                  <p className="text-sm text-slate-600 mb-3 truncate">
                    {delivery.prescription_details}
                  </p>
                  
                  <div className="flex items-center gap-4 text-xs text-slate-500">
                    <div className="flex items-center gap-1">
                      <Calendar className="w-3 h-3" />
                      <span>{getDateLabel(delivery.delivery_date)}</span>
                    </div>
                    {delivery.delivery_time && (
                      <div className="flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        <span>{delivery.delivery_time}</span>
                      </div>
                    )}
                  </div>
                  
                  {patient?.address && (
                    <div className="flex items-center gap-1 mt-2 text-xs text-slate-400">
                      <MapPin className="w-3 h-3" />
                      <span className="truncate">{patient.address}</span>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </CardContent>
    </Card>
  );
}