import React from 'react';
import { Badge } from '@/components/ui/badge';

const hasData = (value) => {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.trim().length > 0;
  return !!value;
};

const BooleanBadge = ({ isPresent }) =>
<Badge className={isPresent ? 'bg-green-100 text-green-800 hover:bg-green-100' : 'bg-red-100 text-red-800 hover:bg-red-100'}>
    {isPresent ? 'True' : 'False'}
  </Badge>;


export default function DeliveryRouteDataCell({ delivery }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        
        <BooleanBadge isPresent={hasData(delivery?.delivery_route_breadcrumbs)} />
      </div>
      <div className="flex items-center justify-between gap-2">
        
        <BooleanBadge isPresent={hasData(delivery?.finished_leg_encoded_polyline)} />
      </div>
    </div>);

}