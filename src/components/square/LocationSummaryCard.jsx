import React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { MapPin } from 'lucide-react';

export default function LocationSummaryCard({ location, codTotal, itemCount, storeColor, onClick }) {
  return (
    <Card
      className="cursor-pointer hover:shadow-md transition-shadow flex-1 h-full max-w-[1px]"
      style={{
        minWidth: '120px',
        borderColor: storeColor?.border || undefined,
        backgroundColor: storeColor?.bg || undefined
      }}
      onClick={onClick}>
      
      <CardContent className="p-2.5 md:p-3 flex flex-col justify-between h-full my-1">
        {/* Store name + location ID */}
        <div className="flex items-start gap-1.5 mb-2">
          <MapPin className="w-3.5 h-3.5 text-emerald-600 flex-shrink-0 mt-0.5" />
          <div className="min-w-0">
            <h3 className="font-semibold text-slate-900 dark:text-slate-50 text-xs md:text-sm leading-tight truncate">
              {location.name}
            </h3>
            <p className="text-[10px] text-slate-400 font-mono truncate leading-tight">
              {location.square_location_id}
            </p>
          </div>
        </div>

        {/* Total + Items side by side */}
        <div className="grid grid-cols-2 gap-1.5">
          <div className="rounded p-1.5" style={{ background: 'rgba(0,0,0,0.04)' }}>
            <div className="text-[10px] text-slate-500 dark:text-slate-400 leading-tight">Total</div>
            <div className="text-sm md:text-base font-bold text-emerald-600 dark:text-emerald-400 leading-tight">
              ${codTotal.toFixed(2)}
            </div>
          </div>
          <div className="rounded p-1.5" style={{ background: 'rgba(0,0,0,0.04)' }}>
            <div className="text-[10px] text-slate-500 dark:text-slate-400 leading-tight">Items</div>
            <div className="text-sm md:text-base font-bold text-blue-600 dark:text-blue-400 leading-tight">
              {itemCount}
            </div>
          </div>
        </div>

        <p className="text-[10px] text-slate-400 mt-1.5 leading-tight">
          Click to view transaction history
        </p>
      </CardContent>
    </Card>);

}