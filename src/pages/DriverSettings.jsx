import React from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Truck, Settings, MapPin, Clock, Bell } from 'lucide-react';

export default function DriverSettings() {
  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-3">
          <Truck className="w-7 h-7 text-emerald-600" />
          Driver Settings
        </h1>
        <p className="text-slate-600 mt-1">Configure driver app settings and preferences</p>
      </div>

      <div className="grid gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MapPin className="w-5 h-5 text-blue-600" />
              Location Tracking
            </CardTitle>
            <CardDescription>
              Configure GPS tracking intervals and accuracy settings
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-slate-500">
              Location tracking settings will be configured here.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Clock className="w-5 h-5 text-orange-600" />
              Route Optimization
            </CardTitle>
            <CardDescription>
              Configure automatic route optimization behavior
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-slate-500">
              Route optimization settings will be configured here.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Bell className="w-5 h-5 text-purple-600" />
              Notifications
            </CardTitle>
            <CardDescription>
              Configure driver notification preferences
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-slate-500">
              Notification settings will be configured here.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Settings className="w-5 h-5 text-slate-600" />
              General Settings
            </CardTitle>
            <CardDescription>
              Other driver app configuration options
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-slate-500">
              General driver settings will be configured here.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}