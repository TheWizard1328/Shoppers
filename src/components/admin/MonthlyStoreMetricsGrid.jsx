import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Table, DollarSign } from 'lucide-react';

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Monthly Store Metrics Grid
 * Shows either:
 * 1. Total deliveries per store per month
 * 2. Total payable app fees per store per month
 */
export default function MonthlyStoreMetricsGrid({ metricsData, selectedYear, onMonthClick, onStoreMonthClick, selectedMonth, selectedStoreMonth, onResetView, onViewModeChange, metricsViewMode, showEnvelopeAdjustedTotals, onEnvelopeToggleChange }) {

  if (!metricsData) return null;

  const monthlyStoreData = metricsData.monthlyStoreData || {};
  const monthlyStoreFees = metricsData.monthlyStoreFees || {};
  
  // Default metricsViewMode if not provided
  const viewMode = metricsViewMode || 'deliveries';

  // Build stores list from monthlyStoreData (all unique stores across all months)
  const storeMap = new Map();
  for (let month = 1; month <= 12; month++) {
    const monthData = monthlyStoreData[month] || [];
    monthData.forEach((store) => {
      if (store.abbreviation && !storeMap.has(store.abbreviation)) {
        storeMap.set(store.abbreviation, store);
      }
    });
  }
  const stores = Array.from(storeMap.values()).sort((a, b) => (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity));

  // Helper to get store ID by abbreviation and month
  const getStoreId = (storeAbbr, month) => {
    const monthData = monthlyStoreData[month] || [];
    const storeData = monthData.find((s) => s.abbreviation === storeAbbr);
    return storeData?.storeId || storeData?.id || null;
  };

  // Calculate totals and averages per store (yearly)
  const calculateStoreTotals = () => {
    const totals = {};
    const counts = {};

    stores.forEach((store) => {
      totals[store.abbreviation] = 0;
      counts[store.abbreviation] = 0;
    });

    // Sum up all months
    for (let month = 1; month <= 12; month++) {
      const monthData = monthlyStoreData[month] || [];
      monthData.forEach((storeData) => {
        if (totals[storeData.abbreviation] !== undefined) {
          let value;
          if (metricsViewMode === 'deliveries') {
            // Total = Completed Deliveries + After Hours + Failed
            const totalDeliveries = (storeData.completed || 0) + (storeData.afterHours || 0) + (storeData.failed || 0);
            // Only add envelope adjustment if toggle is on AND this store has envelope data
            const envelopeInfo = metricsData.envelopeMetrics?.byStoreAndMonth?.[storeData.storeId]?.[month];
            const envelopeAdjustment = (showEnvelopeAdjustedTotals && envelopeInfo?.totalEnvelopeValue > 0) 
              ? (envelopeInfo.totalEnvelopeValue - envelopeInfo.envelopeDeliveriesCount) 
              : 0;
            value = totalDeliveries + envelopeAdjustment;
          } else {
            value = storeData.fees || 0;
          }
          totals[storeData.abbreviation] += value;
          if (value > 0) counts[storeData.abbreviation]++;
        }
      });
    }

    return { totals, counts };
  };

  const { totals, counts } = calculateStoreTotals();

  // Get grand total
  const grandTotal = Object.values(totals).reduce((sum, val) => sum + val, 0);

  // Calculate monthly totals (row totals)
  const getMonthTotal = (month) => {
    const monthData = monthlyStoreData[month] || [];
    return monthData.reduce((sum, store) => {
      let value;
      if (metricsViewMode === 'deliveries') {
        // Total = Completed Deliveries + After Hours + Failed
        const totalDeliveries = (store.completed || 0) + (store.afterHours || 0) + (store.failed || 0);
        // Only add envelope adjustment if toggle is on AND this store has envelope data
        const envelopeInfo = metricsData.envelopeMetrics?.byStoreAndMonth?.[store.storeId]?.[month];
        const envelopeAdjustment = (showEnvelopeAdjustedTotals && envelopeInfo?.totalEnvelopeValue > 0) 
          ? (envelopeInfo.totalEnvelopeValue - envelopeInfo.envelopeDeliveriesCount) 
          : 0;
        value = totalDeliveries + envelopeAdjustment;
      } else {
        value = store.fees || 0;
      }
      return sum + value;
    }, 0);
  };

  // Get value for a specific store and month
  const getValue = (storeAbbr, month) => {
    const monthData = monthlyStoreData[month] || [];
    const storeData = monthData.find((s) => s.abbreviation === storeAbbr);
    if (!storeData) return null;
    
    let value;
    if (metricsViewMode === 'deliveries') {
      // Total = Completed Deliveries + After Hours + Failed
      const totalDeliveries = (storeData.completed || 0) + (storeData.afterHours || 0) + (storeData.failed || 0);
      
      if (showEnvelopeAdjustedTotals) {
        // When toggle is ON: combine deliveries + envelope adjustment into single value
        const envelopeInfo = metricsData.envelopeMetrics?.byStoreAndMonth?.[storeData.storeId]?.[month];
        const envelopeAdjustment = (envelopeInfo?.totalEnvelopeValue > 0) 
          ? (envelopeInfo.totalEnvelopeValue - envelopeInfo.envelopeDeliveriesCount) 
          : 0;
        value = totalDeliveries + envelopeAdjustment;
      } else {
        // When toggle is OFF: show base deliveries (formatValue will add envelope in brackets)
        value = totalDeliveries;
      }
    } else {
      value = storeData.fees || 0;
    }
    return value;
  };

  // Format value based on view mode
  const formatValue = (value, storeId = null, month = null, baseValue = null) => {
    if (value === null || value === undefined) return '';
    if (metricsViewMode === 'fees') {
      return `$${value.toFixed(2)}`;
    }

    // When toggle is OFF: show "deliveries(envelope)" like "74(34)"
    // When toggle is ON: show combined adjusted total like "94"
    if (!showEnvelopeAdjustedTotals && metricsViewMode === 'deliveries' && storeId && month && month !== 'yearTotal') {
      const envelopeInfo = metricsData.envelopeMetrics?.byStoreAndMonth?.[storeId]?.[month];
      if (envelopeInfo && envelopeInfo.totalEnvelopeValue > 0) {
        // Show base deliveries with envelope count in brackets
        return `${value.toLocaleString()}(${envelopeInfo.totalEnvelopeValue})`;
      }
    }
    
    return value.toLocaleString();
  };

  // Get store color for header
  const getStoreColor = (store) => {
    return store.color || '#64748b';
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <p className="text-xs text-slate-500 mb-2">💡 Click a month row name to filter all charts, or click a store value to see day-by-day breakdown</p>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            {metricsViewMode === 'deliveries' ?
            <Table className="w-5 h-5" /> :

            <DollarSign className="w-5 h-5" />
            }
            Monthly Store {metricsViewMode === 'deliveries' ? 'Deliveries' : 'App Fees'} ({selectedYear})
          </CardTitle>
          
          {/* Centered Envelope Totals Toggle */}
          <div className="flex items-center space-x-2">
            <Switch
              id="envelope-totals-grid"
              checked={showEnvelopeAdjustedTotals}
              onCheckedChange={onEnvelopeToggleChange}
            />
            <Label htmlFor="envelope-totals-grid" className="text-xs whitespace-nowrap">Envelope Totals</Label>
          </div>
          
          <div className="flex gap-2">
            {(selectedMonth || selectedStoreMonth) &&
            <Button
              size="sm"
              variant="outline"
              onClick={() => onResetView?.()}
              className="text-xs h-7 px-2">

                Reset View
              </Button>
            }
            <Button
              type="button"
              size="sm"
              variant={metricsViewMode === 'deliveries' ? 'default' : 'outline'}
              onClick={() => onViewModeChange?.('deliveries')}
              className="text-xs h-7 px-2">

              Deliveries
            </Button>
            <Button
              type="button"
              size="sm"
              variant={metricsViewMode === 'fees' ? 'default' : 'outline'}
              onClick={() => onViewModeChange?.('fees')}
              className="text-xs h-7 px-2">

              App Fees
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b bg-slate-50">
                <th className="text-left p-2 font-medium text-slate-600 sticky left-0 bg-slate-50 z-10">Mon</th>
                {stores.map((store) =>
                <th
                  key={store.abbreviation}
                  className="text-center p-2 font-bold min-w-[50px]"
                  style={{ color: getStoreColor(store) }}
                  title={store.name}>

                    {store.abbreviation}
                  </th>
                )}
                <th className="text-center p-2 font-bold text-slate-900 border-l-2 border-purple-300 min-w-[60px]">Tot</th>
              </tr>
            </thead>
            <tbody>
              {MONTH_NAMES.map((monthName, idx) => {
                const month = idx + 1;
                const monthTotal = getMonthTotal(month);
                const isMonthSelected = selectedMonth === month;
                return (
                  <tr key={month} className={`border-b hover:bg-slate-50 ${isMonthSelected ? 'bg-emerald-50' : ''}`}>
                    <td
                      className="p-2 font-medium sticky left-0 bg-white z-10 cursor-pointer hover:bg-emerald-100"
                      style={{ color: isMonthSelected ? '#059669' : '#475569', backgroundColor: isMonthSelected ? '#d1fae5' : 'white' }}
                      onClick={() => onMonthClick?.(month)}>

                      {monthName}
                    </td>
                    {stores.map((store) => {
                      const storeId = getStoreId(store.abbreviation, month);
                      const value = getValue(store.abbreviation, month);
                      const isStoreMonthSelected = selectedStoreMonth?.month === month && selectedStoreMonth?.storeId === storeId;
                      
                      // Leave blank if value is 0, null, or undefined
                      const shouldShowBlank = value === null || value === undefined || value === 0;
                      
                      return (
                        <td
                          key={store.abbreviation}
                          className={`text-center p-2 tabular-nums cursor-pointer hover:bg-blue-100 ${isStoreMonthSelected ? 'bg-blue-200' : ''}`}
                          style={{ color: (value !== null && value !== undefined && value > 0) ? getStoreColor(store) : '#94a3b8' }}
                          onClick={() => {
                            if (value !== null && value !== undefined && value > 0) {
                              // Get the actual storeId from the store object, not from getStoreId
                              const actualStoreId = store.storeId || storeId;
                              if (actualStoreId) {
                                onStoreMonthClick?.(month, actualStoreId, store.abbreviation, store.name);
                              }
                            }
                          }}>

                          {shouldShowBlank ? '' : formatValue(value, storeId, month)}
                        </td>);

                    })}
                    <td className="text-center p-2 font-semibold text-slate-900 border-l-2 border-purple-300 tabular-nums">
                      {monthTotal === 0 ? '' : formatValue(monthTotal)}
                    </td>
                  </tr>);

              })}
              {/* Totals Row */}
              <tr className="border-t-2 border-slate-300 bg-slate-100 font-semibold">
                <td className="p-2 text-slate-700 sticky left-0 bg-slate-100 z-10">Tot</td>
                {stores.map((store) =>
                <td
                  key={store.abbreviation}
                  className="text-center p-2 tabular-nums"
                  style={{ color: getStoreColor(store) }}>

                    {formatValue(totals[store.abbreviation])}
                  </td>
                )}
                <td className="text-center p-2 font-bold text-slate-900 border-l-2 border-purple-300 tabular-nums">
                  {formatValue(grandTotal)}
                </td>
              </tr>
              {/* Average Row */}
              <tr className="bg-slate-50">
                <td className="p-2 text-slate-600 sticky left-0 bg-slate-50 z-10">AVG</td>
                {stores.map((store) => {
                  const avg = counts[store.abbreviation] > 0 ?
                  totals[store.abbreviation] / 12 :
                  0;
                  return (
                    <td
                      key={store.abbreviation}
                      className="text-center p-2 tabular-nums text-slate-600">

                      {avg > 0 ? formatValue(Math.round(avg)) : ''}
                    </td>);

                })}
                <td className="text-center p-2 font-semibold text-slate-700 border-l-2 border-purple-300 tabular-nums">
                  {formatValue(Math.round(grandTotal / 12))}
                </td>
              </tr>
              {/* Percentage Row (only for fees view) */}
              {viewMode === 'fees' && grandTotal > 0 &&
              <tr className="bg-slate-50 border-t">
                  <td className="p-2 text-slate-600 sticky left-0 bg-slate-50 z-10">%</td>
                  {stores.map((store) => {
                  const pct = grandTotal > 0 ?
                  totals[store.abbreviation] / grandTotal * 100 :
                  0;
                  return (
                    <td
                      key={store.abbreviation}
                      className="text-center p-2 tabular-nums text-slate-500">

                        {pct > 0 ? `${pct.toFixed(0)}%` : ''}
                      </td>);

                })}
                  <td className="text-center p-2 text-slate-500 border-l-2 border-purple-300">100%</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>);

}