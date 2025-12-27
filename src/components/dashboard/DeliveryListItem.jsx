
import React from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { format } from 'date-fns';
import { MapPin, Clock, Truck } from 'lucide-react'; // Added Truck import

const storeColors = [
  '#10B981', '#3B82F6', '#8B5CF6', '#F59E0B', '#EF4444',
  '#06B6D4', '#84CC16', '#F97316', '#EC4899', '#6366F1'
];

export default function DeliveryListItem({ delivery, patient, store, stores, stopOrder, onClick, isSelected }) {
    if (!delivery || !patient || !store) return null;

    const isReturned = delivery.delivery_notes && delivery.delivery_notes.toLowerCase().includes('return');
    const isPickup = delivery.delivery_address && delivery.delivery_address.toLowerCase().includes('(pickup)');
    
    // Get store color based on store index in the stores array
    const storeIndex = stores.findIndex(s => s.id === store.id);
    const storeColor = storeColors[storeIndex % storeColors.length];

    // Determine card outline based on status (matching map pins)
    let outlineColor = 'border-slate-200';
    if (isSelected) {
        outlineColor = 'border-blue-500 ring-2 ring-blue-200';
    } else if (delivery.status === 'delivered') {
        outlineColor = 'border-green-700 border-2';
    } else if (delivery.status === 'failed' || isReturned) {
        outlineColor = 'border-red-600 border-2';
    } else if (delivery.status === 'in_transit') {
        outlineColor = 'border-blue-400 border-2';
    } else if (delivery.status === 'pending') {
        outlineColor = 'border-yellow-400 border-2';
    }

    const getStatusBadge = () => {
        const base = "text-xs font-medium px-2 py-0.5 rounded-full";
        if (isPickup) return <Badge className={`${base} bg-blue-100 text-blue-800`}>PICKUP</Badge>;
        if (isReturned) return <Badge className={`${base} bg-red-100 text-red-800`}>RETURN</Badge>;
        switch(delivery.status) {
            case 'delivered': return <Badge className={`${base} bg-emerald-100 text-emerald-800`}>Delivered</Badge>;
            case 'failed': return <Badge className={`${base} bg-red-100 text-red-800`}>Failed</Badge>;
            case 'in_transit': return <Badge className={`${base} bg-blue-100 text-blue-800`}>In Transit</Badge>;
            case 'pending': return <Badge className={`${base} bg-yellow-100 text-yellow-800`}>Pending</Badge>;
            default: return <Badge className={`${base} bg-slate-100 text-slate-800`}>{delivery.status}</Badge>;
        }
    };
    
    const getTimeDisplay = () => {
        if (delivery.status === 'delivered' && delivery.actual_delivery_time) {
            return {
                text: format(new Date(delivery.actual_delivery_time), 'h:mm a'),
                color: 'text-green-600'
            };
        } else if (['failed', 'cancelled'].includes(delivery.status) && delivery.actual_delivery_time) {
            const statusText = isReturned ? 'Returned' : 'Failed';
            return {
                text: `${statusText}: ${format(new Date(delivery.actual_delivery_time), 'h:mm a')}`,
                color: 'text-red-600'
            };
        } else if (delivery.status === 'pending') {
            const timeWindow = delivery.delivery_time_start && delivery.delivery_time_end 
                ? `${delivery.delivery_time_start} - ${delivery.delivery_time_end}`
                : delivery.delivery_time_start
                    ? `After ${delivery.delivery_time_start}`
                    : delivery.delivery_time_end
                        ? `Before ${delivery.delivery_time_end}`
                        : 'Anytime';
            return {
                text: `ETA: ${timeWindow}`,
                color: 'text-yellow-600'
            };
        } else {
            const timeWindow = delivery.delivery_time_start && delivery.delivery_time_end 
                ? `${delivery.delivery_time_start} - ${delivery.delivery_time_end}`
                : delivery.delivery_time_start
                    ? `After ${delivery.delivery_time_start}`
                    : delivery.delivery_time_end
                        ? `Before ${delivery.delivery_time_end}`
                        : 'Anytime';
            return {
                text: timeWindow,
                color: 'text-slate-600'
            };
        }
    };

    const timeDisplay = getTimeDisplay();

    return (
        <Card 
            className={`p-3 cursor-pointer transition-all duration-200 ${outlineColor} hover:shadow-md bg-white`}
            onClick={onClick}
        >
            <div className="flex items-start justify-between gap-3">
                {/* Stop Order Number with Store Color Background */}
                <div 
                    className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-white font-bold text-sm"
                    style={{ backgroundColor: storeColor }}
                >
                    {isPickup ? '↑' : (stopOrder || '●')}
                </div>
                
                <div className="flex-1 min-w-0">
                    <div className="flex items-baseline justify-between gap-2 mb-1">
                        <p className="font-semibold text-slate-900 truncate">{patient.full_name}</p>
                        {/* Store Abbreviation + Tracking with Store Color Background */}
                        <div 
                            className="text-xs text-white font-mono px-1.5 py-0.5 rounded flex-shrink-0"
                            style={{ backgroundColor: storeColor }}
                        >
                            <span className="font-bold">{store.abbreviation}{delivery.tracking_number || 'N/A'}</span>
                        </div>
                    </div>
                    
                    <div className="flex items-center justify-between mb-2">
                        {getStatusBadge()}
                        <div className={`flex items-center gap-1 text-xs ${timeDisplay.color} font-medium`}>
                            <Clock className="w-3 h-3"/>
                            <span>{timeDisplay.text}</span>
                        </div>
                    </div>
                    
                    <div className="flex items-center gap-2 text-xs text-slate-500 mb-2"> {/* Added mb-2 for spacing */}
                        <MapPin className="w-3 h-3 flex-shrink-0"/>
                        <span className="truncate">{delivery.delivery_address || patient.address}</span>
                    </div>

                    {/* Driver Name Display */}
                    <div className="flex items-center gap-1.5 text-xs text-slate-500">
                        <Truck className="w-3 h-3" />
                        <span className="font-medium">
                            {delivery.driver_name ? delivery.driver_name.split(' ')[0] : 'Unassigned'}
                        </span>
                    </div>
                </div>
            </div>
        </Card>
    );
}
