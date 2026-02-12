import React, { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { formatPhoneNumber } from "../utils/phoneFormatter";
import {
  BarChart3,
  Package,
  Calendar,
  CheckCircle,
  Clock,
  ExternalLink,
  XCircle,
  FileText,
  Users,
  ChevronLeft,
  ChevronRight } from
"lucide-react";
import { format } from "date-fns";

const RecentDeliveries = ({ deliveries, patient }) => {

  // Filter deliveries for this patient only (across all drivers)
  const patientDeliveries = deliveries.filter((d) => d.patient_id === patient.id);

  // Group deliveries by date
  const deliveriesByDate = patientDeliveries.reduce((acc, delivery) => {
    const dateKey = delivery.delivery_date;
    if (!acc[dateKey]) acc[dateKey] = [];
    acc[dateKey].push(delivery);
    return acc;
  }, {});

  // Determine badge color for a date
  const getDateBadgeInfo = (dateStr) => {
    const dayDeliveries = deliveriesByDate[dateStr] || [];
    if (dayDeliveries.length === 0) return null;

    const hasCompleted = dayDeliveries.some((d) => ['completed', 'delivered'].includes(d.status));
    const hasFailed = dayDeliveries.some((d) => d.status === 'failed' && !d.delivery_notes?.toLowerCase().includes('return'));
    const hasReturned = dayDeliveries.some((d) => d.status === 'failed' && d.delivery_notes?.toLowerCase().includes('return'));

    // Split badge logic
    if (hasCompleted && hasFailed || hasCompleted && hasReturned) {
      return { type: 'split', left: 'green', right: hasFailed ? 'red' : 'orange' };
    }
    if (hasFailed && hasReturned) {
      return { type: 'split', left: 'red', right: 'orange' };
    }

    // Single badge
    if (hasCompleted) return { type: 'single', color: 'green' };
    if (hasReturned) return { type: 'single', color: 'orange' };
    if (hasFailed) return { type: 'single', color: 'red' };

    return { type: 'single', color: 'gray' };
  };

  const monthStart = startOfMonth(currentMonth);
  const monthEnd = endOfMonth(currentMonth);
  const calendarStart = startOfWeek(monthStart);
  const calendarEnd = endOfWeek(monthEnd);
  const calendarDays = eachDayOfInterval({ start: calendarStart, end: calendarEnd });

  const handlePrevMonth = () => {
    setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1));
  };

  const handleNextMonth = () => {
    setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1));
  };

  return (
    <Card className="shadow-sm" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
      <CardHeader className="px-4 py-2 flex flex-col space-y-1.5">
        <CardTitle className="flex items-center gap-2" style={{ color: 'var(--text-slate-900)' }}>
          <Calendar className="w-5 h-5 text-emerald-600" />
          Delivery History
        </CardTitle>
        <div className="flex items-center justify-center gap-2 mt-2">
          <Button variant="ghost" size="sm" onClick={handlePrevMonth}>
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <span className="text-sm font-medium min-w-[120px] text-center">
            {format(currentMonth, 'MMMM yyyy')}
          </span>
          <Button variant="ghost" size="sm" onClick={handleNextMonth}>
            <ChevronRight className="w-4 h-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {/* Weekday headers */}
        <div className="grid grid-cols-7 gap-1 mb-2">
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) =>
          <div key={day} className="text-center text-xs font-semibold py-2" style={{ color: 'var(--text-slate-600)' }}>
              {day}
            </div>
          )}
        </div>

        {/* Calendar grid */}
        <div className="grid grid-cols-7 gap-1">
          {calendarDays.map((day) => {
            const dateStr = format(day, 'yyyy-MM-dd');
            const todayStr = format(new Date(), 'yyyy-MM-dd');
            const isToday = dateStr === todayStr;
            const badgeInfo = getDateBadgeInfo(dateStr);
            const isCurrentMonth = isSameMonth(day, currentMonth);

            return (
              <div
                key={dateStr}
                className={`aspect-square p-1 rounded-lg flex items-center justify-center text-sm relative ${
                isToday ? 'ring-2 ring-blue-500 ring-inset' : ''}`}
                style={{ color: !isCurrentMonth ? 'var(--text-slate-300)' : 'var(--text-slate-900)' }}>

                {badgeInfo ?
                badgeInfo.type === 'split' ?
                <div className="relative w-full h-full flex items-center justify-center">
                      <div className="absolute inset-0 flex">
                        <div className={`w-1/2 rounded-l-lg ${
                    badgeInfo.left === 'green' ? 'bg-emerald-500' :
                    badgeInfo.left === 'red' ? 'bg-red-500' :
                    'bg-orange-500'}`
                    } />
                        <div className={`w-1/2 rounded-r-lg ${
                    badgeInfo.right === 'green' ? 'bg-emerald-500' :
                    badgeInfo.right === 'red' ? 'bg-red-500' :
                    'bg-orange-500'}`
                    } />
                      </div>
                      <span className="relative z-10 font-semibold text-white">
                        {format(day, 'd')}
                      </span>
                    </div> :

                <div className={`w-full h-full rounded-lg flex items-center justify-center font-semibold text-white ${
                badgeInfo.color === 'green' ? 'bg-emerald-500' :
                badgeInfo.color === 'red' ? 'bg-red-500' :
                badgeInfo.color === 'orange' ? 'bg-orange-500' :
                'bg-slate-400'}`
                }>
                      {format(day, 'd')}
                    </div> :


                <span>{format(day, 'd')}</span>
                }
              </div>);

          })}
        </div>

        {/* Legend */}
        <div className="flex flex-wrap gap-4 mt-4 pt-4 text-xs" style={{ borderTop: '1px solid var(--border-slate-200)' }}>
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 rounded bg-emerald-500" />
            <span style={{ color: 'var(--text-slate-600)' }}>Completed</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 rounded bg-red-500" />
            <span style={{ color: 'var(--text-slate-600)' }}>Failed</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 rounded bg-orange-500" />
            <span style={{ color: 'var(--text-slate-600)' }}>Returned</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 rounded flex">
              <div className="w-1/2 bg-emerald-500 rounded-l" />
              <div className="w-1/2 bg-red-500 rounded-r" />
            </div>
            <span style={{ color: 'var(--text-slate-600)' }}>Mixed Status</span>
          </div>
        </div>
      </CardContent>
    </Card>);

};

export default function PatientDetails({ patient, deliveries, deliveryStats }) {
  if (!patient) {
    return (
      <div className="text-center py-10" style={{ color: 'var(--text-slate-500)' }}>
        <p className="text-lg mb-2">Select a patient to view details</p>
        <p className="text-sm">Click on any patient card on the left to see analytics and recent delivery history.</p>
      </div>);

  }

  // Day abbreviation mapping for consistent display
  const dayAbbreviations = {
    'Monday': 'Mon',
    'Tuesday': 'Tue',
    'Wednesday': 'Wed',
    'Thursday': 'Thu',
    'Friday': 'Fri',
    'Saturday': 'Sat',
    'Sunday': 'Sun'
  };

  return (
    <div className="space-y-6 sticky top-6">
      {/* Delivery Statistics */}
      {deliveryStats &&
      <Card className="shadow-sm" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2" style={{ color: 'var(--text-slate-900)' }}>
              <BarChart3 className="w-5 h-5 text-blue-600" />
              Delivery Analytics
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 space-y-2">
            <div className="grid grid-cols-2 gap-4">
              <div className="text-center p-3 rounded-lg" style={{ background: 'var(--bg-slate-50)' }}>
                <p className="text-2xl font-bold" style={{ color: 'var(--text-slate-900)' }}>{deliveryStats.totalDeliveries}</p>
                <p className="text-sm" style={{ color: 'var(--text-slate-600)' }}>Total</p>
              </div>
              <div className="text-center p-3 bg-emerald-50 rounded-lg">
                <p className="text-2xl font-bold text-emerald-700">
                  {deliveryStats.mostCommonDay ? dayAbbreviations[deliveryStats.mostCommonDay] || deliveryStats.mostCommonDay.substring(0, 3) : 'N/A'}
                </p>
                <p className="text-sm" style={{ color: 'var(--text-slate-600)' }}>Most Common Day</p>
              </div>
            </div>

            {deliveryStats.lastDeliveryDate &&
          <div className="flex items-center gap-3 text-sm p-3 rounded-lg" style={{ background: 'var(--bg-slate-50)' }}>
                <Calendar className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--text-slate-500)' }} />
                <div>
                  <p className="font-medium" style={{ color: 'var(--text-slate-900)' }}>Last Delivery</p>
                  <p style={{ color: 'var(--text-slate-600)' }}>
                    {format(new Date(deliveryStats.lastDeliveryDate + 'T12:00:00'), 'EEE, MMM d, yyyy')}
                  </p>
                </div>
              </div>
          }

            {deliveryStats.dayFrequency && Object.keys(deliveryStats.dayFrequency).length > 0 &&
          <div>
                <p className="font-medium mb-3" style={{ color: 'var(--text-slate-900)' }}>Delivery Pattern</p>
                <div className="space-y-2">
                  {Object.entries(deliveryStats.dayFrequency).
              sort(([, a], [, b]) => b - a).
              map(([day, count]) =>
              <div key={day} className="flex justify-between items-center text-sm">
                        <span className="min-w-[40px]" style={{ color: 'var(--text-slate-600)' }}>{dayAbbreviations[day] || day.substring(0, 3)}</span>
                        <div className="flex items-center gap-2 flex-1">
                          <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ background: 'var(--bg-slate-200)' }}>
                            <div
                      className="h-full bg-emerald-500 rounded-full transition-all duration-300"
                      style={{ width: `${count / deliveryStats.totalDeliveries * 100}%` }} />

                          </div>
                          <Badge variant="outline" className="text-xs min-w-[2.5rem] justify-center">
                            {count}
                          </Badge>
                        </div>
                      </div>
              )}
                </div>
              </div>
          }
          </CardContent>
        </Card>
      }

      {/* Delivery Calendar */}
      <DeliveryCalendar deliveries={deliveries} patient={patient} />
    </div>);

}