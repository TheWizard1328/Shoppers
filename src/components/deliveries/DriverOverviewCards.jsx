import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

export default function DriverOverviewCards({ driverCards, getDriverStatusBadgeClass, handleDriverCardClick }) {
  return (
    <div className="flex-1 min-h-0 w-full overflow-y-auto" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '12px', alignContent: 'start', marginBottom: 'var(--bottom-nav-height, 0px)', paddingBottom: '12px', boxSizing: 'border-box' }}>
      {driverCards.map((card, index) => {
        const driverKey = card?.driver?.id || card?.driver?.appUserId || `${card?.firstName || 'driver'}-${index}`;
        const driverBadgeClass = getDriverStatusBadgeClass(card.driver.id, card.driver.driver_status);
        return (
          <Card
            key={driverKey}
            className="bg-card text-card-foreground rounded-xl border shadow cursor-pointer transition-shadow backdrop-blur-sm hover:shadow-lg h-auto"
            style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)', color: 'var(--text-slate-900)', minWidth: '280px', display: 'flex', flexDirection: 'column' }}
            onClick={() => handleDriverCardClick(card.driver)}
          >
            <CardHeader className="px-6 py-2 flex flex-col space-y-1.5">
              <CardTitle className="text-base flex items-center justify-between">
                <span className="text-lg font-bold" style={{ color: 'var(--text-slate-900)' }}>{card.firstName}</span>
                <Badge variant="outline" className={`px-2.5 py-0.5 text-xs font-semibold rounded-full w-[90px] inline-flex items-center justify-center border transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 ${driverBadgeClass}`}>
                  {card.stats.totalStops} stops
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-6 px-4 py-3 flex flex-col">
              <div className="mb-3 flex items-center justify-center" style={{ borderBottom: '1px solid var(--border-slate-100)' }}>
                {card.todayStats && card.todayStats.total > 0 ? (
                  <div className="flex items-center justify-center gap-2 text-xs font-medium flex-wrap">
                    <span className="text-blue-600">Active: {card.todayStats.active}</span>
                    <span className="text-green-600">Comp: {card.todayStats.completed}</span>
                    <span className="text-red-600">Failed: {card.todayStats.failed}</span>
                    <span className="text-orange-600">Returns: {card.todayStats.returned}</span>
                  </div>
                ) : (
                  <div className="text-xs" style={{ color: 'var(--text-slate-400)' }}>No deliveries today</div>
                )}
              </div>
              <div className="space-y-1 text-sm">
                <div className="flex justify-between items-center">
                  <span style={{ color: 'var(--text-slate-600)' }}>Pickups:</span>
                  <span className="bg-blue-500 text-white px-3 py-1 text-xs rounded-full font-medium w-[60px] text-center">{card.stats.pickups}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span style={{ color: 'var(--text-slate-600)' }}>Completed:</span>
                  <span className="bg-emerald-500 text-white px-3 py-1 text-xs rounded-full font-medium w-[60px] text-center">{card.stats.completed}</span>
                </div>
                {(card.stats.failed > 0 || card.stats.returned > 0) && (
                  <div className="flex justify-between items-center">
                    <span style={{ color: 'var(--text-slate-600)' }}>Failed/Returned:</span>
                    <span className="bg-red-500 text-white px-3 py-1 text-xs rounded-full font-medium w-[60px] text-center">{card.stats.failed}/{card.stats.returned}</span>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}