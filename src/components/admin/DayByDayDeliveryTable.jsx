import React, { useMemo } from 'react';

export default function DayByDayDeliveryTable({ metricsData, selectedMonth, selectedYear }) {
  if (!metricsData || !selectedMonth) {
    return <p className="text-slate-500">Select a month to view day-by-day breakdown.</p>;
  }

  const daysInMonth = new Date(parseInt(selectedYear), selectedMonth, 0).getDate();
  const dailyStoreData = metricsData.dailyStoreData?.[selectedMonth] || {};
  
  // Get all stores for this month
  const stores = useMemo(() => {
    const allStores = metricsData.storeDataByMonth?.[selectedMonth] || metricsData.storeData || [];
    return allStores.sort((a, b) => (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity));
  }, [metricsData, selectedMonth]);

  // Build data: day -> store -> deliveries
  const tableData = useMemo(() => {
    const data = [];
    
    for (let day = 1; day <= daysInMonth; day++) {
      const dayRow = { day };
      let dayTotal = 0;

      stores.forEach(store => {
        const storeId = store.storeId;
        const dayStoreData = dailyStoreData[storeId]?.find(d => d.day === day);
        // Billable deliveries = completed + after hours (same as summary)
        const billable = (dayStoreData?.completed || 0) + (dayStoreData?.afterHours || 0);
        dayRow[storeId] = billable;
        dayTotal += billable;
      });
      
      dayRow.total = dayTotal;
      data.push(dayRow);
    }
    
    return data;
  }, [daysInMonth, stores, dailyStoreData]);

  // Calculate totals and averages
  const totals = useMemo(() => {
    const storeTotal = {};
    let grandTotal = 0;

    stores.forEach(store => {
      storeTotal[store.storeId] = tableData.reduce((sum, row) => sum + (row[store.storeId] || 0), 0);
      grandTotal += storeTotal[store.storeId];
    });

    return { storeTotal, grandTotal };
  }, [stores, tableData]);

  const averages = useMemo(() => {
    const storeAvg = {};
    stores.forEach(store => {
      storeAvg[store.storeId] = Math.round(totals.storeTotal[store.storeId] / daysInMonth);
    });
    return storeAvg;
  }, [stores, totals, daysInMonth]);

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            <th className="border border-slate-200 px-3 py-2 bg-slate-50 text-left font-semibold text-slate-700">Day</th>
            {stores.map(store => (
              <th
                key={store.storeId}
                className="border border-slate-200 px-3 py-2 bg-slate-50 text-center font-semibold text-xs whitespace-nowrap"
                style={{ color: store.color || '#64748b' }}
              >
                {store.abbreviation}
              </th>
            ))}
            <th className="border border-slate-200 px-3 py-2 bg-slate-50 text-center font-semibold text-slate-700">Total</th>
          </tr>
        </thead>
        <tbody>
          {tableData.map(row => (
            <tr key={row.day}>
              <td className="border border-slate-200 px-3 py-2 font-medium text-slate-700">{row.day}</td>
              {stores.map(store => (
                <td
                  key={store.storeId}
                  className="border border-slate-200 px-3 py-2 text-center text-slate-600"
                >
                  {row[store.storeId] || 0}
                </td>
              ))}
              <td className="border border-slate-200 px-3 py-2 text-center font-semibold text-slate-700 bg-slate-50">
                {row.total}
              </td>
            </tr>
          ))}
          {/* Totals Row */}
          <tr className="font-semibold bg-slate-50">
            <td className="border border-slate-200 px-3 py-2 text-slate-700">Total</td>
            {stores.map(store => (
              <td
                key={store.storeId}
                className="border border-slate-200 px-3 py-2 text-center text-slate-700"
                style={{ color: store.color || '#64748b' }}
              >
                {totals.storeTotal[store.storeId]}
              </td>
            ))}
            <td className="border border-slate-200 px-3 py-2 text-center text-slate-900">
              {totals.grandTotal}
            </td>
          </tr>
          {/* Average Row */}
          <tr className="text-slate-600 bg-slate-50">
            <td className="border border-slate-200 px-3 py-2 text-sm">AVG</td>
            {stores.map(store => (
              <td
                key={store.storeId}
                className="border border-slate-200 px-3 py-2 text-center text-sm"
              >
                {averages[store.storeId]}
              </td>
            ))}
            <td className="border border-slate-200 px-3 py-2 text-center text-sm font-semibold">
              {Math.round(totals.grandTotal / daysInMonth)}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}