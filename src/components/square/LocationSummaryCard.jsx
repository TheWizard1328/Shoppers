import React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { MapPin } from 'lucide-react';

export default function LocationSummaryCard({ location, codTotal, itemCount, onClick }) {
  return (
    <Card 
      className="cursor-pointer hover:shadow-lg transition-shadow"
      onClick={onClick}
    >
      <CardContent className="p-4">
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-start gap-2">
            <MapPin className="w-5 h-5 text-emerald-600 flex-shrink-0 mt-0.5" />
            <div>
              <h3 className="font-semibold text-slate-900">{location.name}</h3>
              <p className="text-xs text-slate-500 font-mono">{location.square_location_id}</p>
            </div>
          </div>
        </div>
        
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-slate-50 rounded p-2">
            <div className="text-xs text-slate-500">Total</div>
            <div className="text-lg font-bold text-emerald-600">${codTotal.toFixed(2)}</div>
          </div>
          <div className="bg-slate-50 rounded p-2">
            <div className="text-xs text-slate-500">Items</div>
            <div className="text-lg font-bold text-blue-600">{itemCount}</div>
          </div>
        </div>

        <p className="text-xs text-slate-500 mt-3">Click to view transaction history</p>
      </CardContent>
    </Card>
  );
}