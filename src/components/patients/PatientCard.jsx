import React, { useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Phone,
  MapPin,
  Clock,
  StickyNote,
  Edit,
  Trash2,
  Plus,
  MoreVertical,
  RefreshCw,
  Info,
  Package,
  Calendar,
  TrendingUp,
  Bell,
  BellOff,
  Mailbox } from
"lucide-react";
import { formatPhoneNumber } from "../utils/formatters";
import { formatAddressWithUnit } from '../utils/formatters';
import { format } from "date-fns";

import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator } from
"@/components/ui/dropdown-menu";

// Helper to get recurring info from BOOLEAN FIELDS (not notes)
const getRecurringDisplay = (patient) => {
  if (!patient) return null;

  // Define day order and map once for consistent sorting
  const dayOrder = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const dayMap = { sun: 'Sun', mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat' };

  if (patient.recurring_daily) {
    return 'Daily';
  }

  // Check for bi-weekly FIRST (before general weekly check)
  if (patient.recurring_biweekly) {
    // Find which days are scheduled
    const weeklyDays = [];
    dayOrder.forEach((day) => {// Use ordered dayOrder for consistent sorting
      if (patient[`recurring_weekly_${day}`]) {
        weeklyDays.push(dayMap[day]);
      }
    });

    if (weeklyDays.length > 0) {
      return `Bi-Weekly (${weeklyDays.join(', ')})`;
    }
    return 'Bi-Weekly'; // If recurring_biweekly is true, but no specific days are checked
  }

  // Check for weekly x4
  if (patient.recurring_weekly_x4) {
    // Use recurring_weekly_x4_day if available
    if (patient.recurring_weekly_x4_day) {
      const day = dayMap[patient.recurring_weekly_x4_day] || patient.recurring_weekly_x4_day;
      return `Weekly x4 (${day})`;
    }
    
    // Fallback: Find which days are scheduled from boolean fields
    const weeklyDays = [];
    dayOrder.forEach((day) => {
      if (patient[`recurring_weekly_${day}`]) {
        weeklyDays.push(dayMap[day]);
      }
    });

    if (weeklyDays.length > 0) {
      return `Weekly x4 (${weeklyDays.join(', ')})`;
    }
    return 'Weekly x4';
  }

  // Now check for general weekly patterns (only if NOT bi-weekly or weekly x4 and there are weekly days)
  const weeklyDays = [];
  dayOrder.forEach((day) => {// Use ordered dayOrder for consistent sorting
    if (patient[`recurring_weekly_${day}`]) {
      weeklyDays.push(dayMap[day]);
    }
  });

  if (weeklyDays.length > 0) {
    return `Weekly (${weeklyDays.join(', ')})`;
  }

  if (patient.recurring_bimonthly) {// Added this new condition
    return 'Bi-Monthly';
  }

  if (patient.recurring_monthly) {
    return 'Monthly';
  }

  return null;
};

export default function PatientCard({
  patient,
  store,
  onEdit,
  onDelete,
  onCreateDelivery,
  drivers = [],
  allPatients = [],
  allDeliveries = [],
  onSelect,
  isSelected = false,
  showStoreBadge = true,
  displayPriority,
  todayDelivery,
  onStatusToggle
}) {

  const handleEdit = (e) => {
    e.stopPropagation();
    onEdit?.(patient);
  };

  const handleDelete = (e) => {
    e.stopPropagation();
    if (window.confirm(`Are you sure you want to delete ${patient.full_name}? This cannot be undone.`)) {
      onDelete?.(patient);
    }
  };

  const handleCreateDelivery = (e) => {
    e.stopPropagation();
    onCreateDelivery?.(patient);
  };

  const displayAddress = formatAddressWithUnit(patient?.address || "", patient?.unit_number || "");

  const deliveryPreferences = patient.delivery_preferences ?
  patient.delivery_preferences.split(',').map((p) => p.trim()).filter((p) => p !== '') :
  [];

  const recurringText = useMemo(() => getRecurringDisplay(patient), [patient]);

  return (
    <Card
      className={`overflow-hidden transition-all duration-200 hover:shadow-lg cursor-pointer ${
      patient.status === 'inactive' ?
      'border-2 border-red-500 hover:border-red-600' :
      showStoreBadge && store?.color ?
      `border-2 hover:border-opacity-80` :
      'hover:border-emerald-400'} ${
      isSelected ? 'ring-2 ring-emerald-500 border-emerald-500' : ''}`}
      style={{
        background: 'var(--bg-white)',
        borderColor: patient.status !== 'inactive' && showStoreBadge && store?.color ? store.color : 'var(--border-slate-200)',
        color: 'var(--text-slate-900)'
      }}
      onClick={() => onSelect?.(patient)}>

      <CardContent className="p-4">
        <div className="flex justify-between items-start mb-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <h3 className="font-semibold text-base truncate" style={{ color: 'var(--text-slate-900)' }}>
                {patient.full_name}
              </h3>
              {todayDelivery &&
              <Badge style={{ background: 'var(--bg-slate-100)', color: 'var(--text-slate-700)' }}>
                  On Route
                </Badge>
              }
              {store && showStoreBadge &&
              <Badge style={{ backgroundColor: store.color, color: 'white' }} className="bg-primary text-primary-foreground px-2.5 py-0.5 text-xs font-semibold rounded-[10px] inline-flex items-center border transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 border-transparent shadow hover:bg-primary/80">
                  {store.abbreviation || store.name}
                </Badge>
              }
            </div>
            {patient.status === 'inactive' &&
            <div className="mb-1">
                <Badge className="bg-red-500 text-white border border-red-600">INACTIVE</Badge>
              </div>
            }
            <p className="text-sm" style={{ color: 'var(--text-slate-600)' }}>{displayAddress}</p>
            {patient.phone && <p className="text-sm" style={{ color: 'var(--text-slate-500)' }}>{formatPhoneNumber(patient.phone)}</p>}
            {(patient.distance_from_store && store) || (patient.call_upon_arrival || patient.ring_bell || patient.dont_ring_bell || patient.mailbox_ok) ?
            <div className="flex items-center gap-2 mt-1">
                {patient.distance_from_store && store &&
                <span className="text-xs" style={{ color: 'var(--text-slate-500)' }}>
                  {patient.distance_from_store.toFixed(1)} km
                </span>
                }
                {/* Delivery Preferences Icons Badge */}
                {(patient.call_upon_arrival || patient.ring_bell || patient.dont_ring_bell || patient.mailbox_ok) &&
                <Badge
                  variant="secondary"
                  className="bg-slate-300 text-white text-sm font-bold rounded-full inline-flex items-center gap-0.5 px-1.5 py-0.5">
                    {patient.call_upon_arrival &&
                      <Phone className="w-3 h-3 text-amber-600" />
                    }
                    {patient.ring_bell && !patient.dont_ring_bell &&
                      <Bell className="w-3 h-3 text-emerald-600" />
                    }
                    {patient.dont_ring_bell &&
                      <BellOff className="w-3 h-3 text-red-600" />
                    }
                    {patient.mailbox_ok &&
                      <Mailbox className="w-3 h-3 text-blue-600" />
                    }
                  </Badge>
                }
              </div>
            : null
            }
          </div>

          <div className="flex flex-col items-center gap-1 ml-2">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 hover:text-slate-600"
              style={{ color: 'var(--text-slate-400)' }}
              onClick={handleEdit}
              title="Edit Patient">

              <Edit className="w-4 h-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-emerald-500 hover:text-emerald-700"
              onClick={handleCreateDelivery}
              title="Add to Route">

              <Plus className="w-4 h-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-red-400 hover:text-red-600"
              onClick={handleDelete}
              title="Delete Patient">

              <Trash2 className="w-4 h-4" />
            </Button>
          </div>
        </div>

        {/* Quick Info Icons (Badges) */}
        <div className="flex gap-2 mt-3 flex-wrap">
          {(patient.time_window_start || patient.time_window_end) &&
          <Badge variant="outline" className="text-xs" style={{ background: 'var(--bg-slate-100)', color: 'var(--text-slate-700)', borderColor: 'var(--border-slate-300)' }}>
              <Clock className="w-4 h-3 mr-1" />
              {patient.time_window_start || '...'}-{patient.time_window_end || '...'}
            </Badge>
          }
          {recurringText &&
          <Badge variant="outline" className="text-xs" style={{ background: 'var(--bg-slate-100)', color: 'var(--text-slate-700)', borderColor: 'var(--border-slate-300)' }}>
              <RefreshCw className="w-4 h-3 mr-1" />
              {recurringText}
            </Badge>
          }
          {deliveryPreferences.length > 0 &&
          <Badge variant="outline" className="text-xs" style={{ background: 'var(--bg-slate-100)', color: 'var(--text-slate-700)', borderColor: 'var(--border-slate-300)' }}>
              <Info className="w-4 h-3 mr-1" />
              {deliveryPreferences.join(', ')}
            </Badge>
          }
        </div>

        {/* Patient Notes */}
        {patient.notes &&
        <div className="mt-3 pt-3" style={{ borderTop: '1px solid var(--border-slate-100)' }}>
            <div className="text-xs font-semibold mb-1 flex items-center gap-1" style={{ color: 'var(--text-slate-500)' }}>
              <StickyNote className="w-3 h-3" />
              Notes:
            </div>
            <div className="text-xs p-2 rounded" style={{ color: 'var(--text-slate-700)', background: 'var(--bg-slate-50)' }}>
              {patient.notes.split('\n').map((line, i) =>
            <div key={i}>{line}</div>
            )}
            </div>
          </div>
        }
      </CardContent>
    </Card>);

}