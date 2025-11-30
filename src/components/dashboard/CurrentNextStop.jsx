import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MapPin, Clock, Phone, Navigation, Package } from "lucide-react";
import { format } from "date-fns";

export default function CurrentNextStop({ 
  deliveries = [], 
  patients = [], 
  stores = [], 
  currentUser, 
  isLoading,
  currentDate 
}) {
  if (isLoading) {
    return (
      <Card className="bg-white border-slate-200 shadow-sm">
        <CardHeader>
          <CardTitle>Current & Next Stop</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="animate-pulse space-y-4">
            <div className="h-4 bg-slate-200 rounded w-3/4"></div>
            <div className="h-3 bg-slate-200 rounded w-1/2"></div>
            <div className="h-8 bg-slate-200 rounded w-full"></div>
          </div>
        </CardContent>
      </Card>
    );
  }

  // Get today's deliveries for current user
  const today = format(currentDate || new Date(), 'yyyy-MM-dd');
  const todayDeliveries = (deliveries || []).filter(d => 
    d && d.delivery_date === today
  );

  // Find current delivery (in_transit) or next delivery (pending/picked_up)
  const currentDelivery = todayDeliveries.find(d => d && d.status === 'in_transit');
  const nextDelivery = todayDeliveries.find(d => d && ['pending', 'picked_up'].includes(d.status));
  
  const focusDelivery = currentDelivery || nextDelivery;
  
  if (!focusDelivery) {
    return (
      <Card className="bg-white border-slate-200 shadow-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MapPin className="w-5 h-5 text-emerald-600" />
            Current & Next Stop
          </CardTitle>
        </CardHeader>
        <CardContent className="text-center py-8">
          <Package className="w-12 h-12 text-slate-300 mx-auto mb-4" />
          <p className="text-slate-500">No active deliveries for today</p>
        </CardContent>
      </Card>
    );
  }

  const patient = (patients || []).find(p => p && p.id === focusDelivery.patient_id);
  
  if (!patient) {
    return (
      <Card className="bg-white border-slate-200 shadow-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MapPin className="w-5 h-5 text-emerald-600" />
            Current & Next Stop
          </CardTitle>
        </CardHeader>
        <CardContent className="text-center py-8">
          <p className="text-slate-500">Patient information not available</p>
        </CardContent>
      </Card>
    );
  }

  const getStatusColor = (status) => {
    switch (status) {
      case 'in_transit': return 'bg-blue-100 text-blue-800';
      case 'picked_up': return 'bg-yellow-100 text-yellow-800';
      case 'pending': return 'bg-slate-100 text-slate-800';
      default: return 'bg-slate-100 text-slate-800';
    }
  };

  const getStatusLabel = (status) => {
    switch (status) {
      case 'in_transit': return 'En Route';
      case 'picked_up': return 'Picked Up';
      case 'pending': return 'Next Stop';
      default: return status ? status.replace('_', ' ') : 'Unknown';
    }
  };

  return (
    <Card className="bg-white border-slate-200 shadow-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MapPin className="w-5 h-5 text-emerald-600" />
          {focusDelivery.status === 'in_transit' ? 'Current Stop' : 'Next Stop'}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-start justify-between">
          <div className="flex-1">
            <h3 className="font-semibold text-slate-900 text-lg">
              {patient.full_name}
            </h3>
            <p className="text-slate-600 text-sm mt-1">
              {patient.address}
            </p>
          </div>
          <Badge className={`${getStatusColor(focusDelivery.status)} ml-2`}>
            {getStatusLabel(focusDelivery.status)}
          </Badge>
        </div>

        {focusDelivery.prescription_details && (
          <div className="p-3 bg-slate-50 rounded-lg">
            <p className="text-sm font-medium text-slate-700 mb-1">Prescription</p>
            <p className="text-sm text-slate-600">{focusDelivery.prescription_details}</p>
          </div>
        )}

        <div className="grid grid-cols-2 gap-4 text-sm">
          {(focusDelivery.delivery_time_start || focusDelivery.delivery_time_end) && (
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4 text-slate-400" />
              <span className="text-slate-600">
                {focusDelivery.delivery_time_start && focusDelivery.delivery_time_end
                  ? `${focusDelivery.delivery_time_start} - ${focusDelivery.delivery_time_end}`
                  : focusDelivery.delivery_time_start
                    ? `After ${focusDelivery.delivery_time_start}`
                    : `Before ${focusDelivery.delivery_time_end}`
                }
              </span>
            </div>
          )}
          
          {patient.phone && (
            <div className="flex items-center gap-2">
              <Phone className="w-4 h-4 text-slate-400" />
              <span className="text-slate-600">{patient.phone}</span>
            </div>
          )}
        </div>

        {focusDelivery.delivery_instructions && (
          <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg">
            <p className="text-sm font-medium text-amber-800 mb-1">Special Instructions</p>
            <p className="text-sm text-amber-700">{focusDelivery.delivery_instructions}</p>
          </div>
        )}

        <div className="flex gap-2">
          {patient.address && (
            <Button 
              variant="outline" 
              size="sm" 
              className="flex-1 gap-2"
              onClick={() => {
                const address = encodeURIComponent(patient.address);
                window.open(`https://www.google.com/maps/dir/?api=1&destination=${address}`, '_blank');
              }}
            >
              <Navigation className="w-4 h-4" />
              Navigate
            </Button>
          )}
          
          {patient.phone && (
            <Button 
              variant="outline" 
              size="sm" 
              className="flex-1 gap-2"
              onClick={() => window.open(`tel:${patient.phone}`, '_self')}
            >
              <Phone className="w-4 h-4" />
              Call
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}