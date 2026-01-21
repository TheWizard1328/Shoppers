import React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { MapPin, DollarSign } from 'lucide-react';

export default function SquareLocationCards({ locations, catalogItems, onLocationClick }) {
  if (!locations || locations.length === 0) {
    return null;
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
      {locations.map((location) => {
        const locationItems = catalogItems.filter(item => item.location_id === location.square_location_id);
        const total = locationItems.reduce((sum, item) => sum + (item.price_dollars || 0), 0);

        return (
          <Card
            key={location.id}
            className="cursor-pointer hover:shadow-lg transition-shadow"
            onClick={() => onLocationClick(location)}
          >
            <CardContent className="p-4">
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <MapPin className="w-5 h-5 text-slate-500 flex-shrink-0" />
                  <h3 className="font-semibold text-slate-900 truncate">{location.name}</h3>
                </div>
              </div>
              <div className="space-y-2">
                <p className="text-sm text-slate-600">{locationItems.length} pending items</p>
                <div className="flex items-center gap-2 pt-2 border-t">
                  <DollarSign className="w-4 h-4 text-emerald-600" />
                  <span className="text-lg font-bold text-emerald-600">${total.toFixed(2)}</span>
                </div>
              </div>
              <p className="text-xs text-slate-500 mt-3">Click to view transaction history</p>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}