import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DollarSign } from "lucide-react";

const formatAmount = (value) => {
  const amount = Number(value || 0);
  return `$${amount.toFixed(2)}`;
};

const formatDate = (value) => {
  if (!value) return "N/A";
  const normalized = String(value).includes("T") ? new Date(value) : new Date(`${value}T00:00:00`);
  if (Number.isNaN(normalized.getTime())) return "N/A";
  return normalized.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
};

const getRowKey = (row, index) => [
  row.id,
  row.catalogId,
  row.locationId,
  row.deliveryDate,
  row.collectionDate,
  row.itemName,
  index
].filter(Boolean).join("|");

export default function SquareCodDatasetTable({
  title,
  rows,
  isLoading,
  emptyTitle,
  emptyDescription,
  showLocationColumn,
  navHeight,
  onRowClick
}) {
  return (
    <Card className="bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 flex flex-col md:flex-1 md:min-h-0">
      <CardHeader className="sticky top-0 z-10 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-700 flex-shrink-0">
        <CardTitle className="text-base md:text-lg text-slate-900 dark:text-slate-50">{title}</CardTitle>
      </CardHeader>
      <CardContent className="p-0 overflow-hidden flex flex-col md:flex-1 md:min-h-0">
        {isLoading ?
        <div className="flex items-center justify-center py-12 px-6">
            <div className="animate-spin w-8 h-8 border-4 rounded-full" style={{ borderColor: 'var(--border-emerald-500)', borderTopColor: 'transparent' }} />
          </div> :
        rows.length === 0 ?
        <div className="text-center py-12 px-6 text-slate-500 dark:text-slate-400">
            <DollarSign className="w-10 md:w-12 h-10 md:h-12 mx-auto mb-4 opacity-50" />
            <p className="text-sm md:text-base">{emptyTitle}</p>
            {emptyDescription && <p className="text-xs md:text-sm mt-1">{emptyDescription}</p>}
          </div> :

        <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
            <div className="hidden md:flex flex-col flex-1 min-h-0 overflow-hidden">
              <div className="overflow-x-auto px-0">
                <table className="w-full table-fixed">
                  <thead className="bg-white dark:bg-slate-900">
                    <tr className="border-b text-left text-sm text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700">
                      <th className="p-3">Item Name</th>
                      <th className="p-3">Amount</th>
                      <th className="p-3">Store</th>
                      {showLocationColumn && <th className="p-3">Square Location ID</th>}
                      <th className="p-3">Transaction ID</th>
                      <th className="p-3">Actions</th>
                    </tr>
                  </thead>
                </table>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto overflow-x-auto" style={{ paddingBottom: navHeight ? navHeight + 8 : 8 }}>
                <table className="w-full table-fixed">
                  <tbody>
                    {rows.map((row, index) =>
                  <tr
                    key={getRowKey(row, index)}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                    className="transition-colors border-b border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800/50">
                    
                        <td className="p-3">
                          <div className="font-medium text-sm text-slate-900 dark:text-slate-50">{row.itemName || 'N/A'}</div>
                          <div className="text-xs mt-1 text-slate-500 dark:text-slate-400">{formatDate(row.collectionDate || row.deliveryDate)}</div>
                        </td>
                        <td className="p-3">
                          <div className="text-sm font-semibold text-emerald-600 dark:text-emerald-400">{formatAmount(row.amount)}</div>
                          {row.collectionType && (
                            <div
                              className={`inline-flex mt-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${String(row.collectionType).toLowerCase().includes('cash') ? 'border-emerald-200 dark:border-emerald-800 bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300' : 'border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300'}`}
                            >
                              {row.collectionType}
                            </div>
                          )}
                        </td>
                        <td className="p-3">
                          <div className="text-sm text-slate-900 dark:text-slate-50">{row.storeName || 'Unknown'}</div>
                          {row.subtext && <div className="text-xs mt-1 text-slate-500 dark:text-slate-400">{row.subtext}</div>}
                        </td>
                        {showLocationColumn &&
                    <td className="p-3">
                            <div className="text-xs font-mono truncate max-w-[180px] text-slate-600 dark:text-slate-400">{row.locationId || '--'}</div>
                          </td>
                    }
                        <td className="p-3">
                          <div className="text-xs font-mono truncate max-w-[150px] text-slate-600 dark:text-slate-400">{row.catalogId || '--'}</div>
                        </td>
                        <td className="p-3">
                          <div className="space-y-1">
                            <div className="flex justify-start" onClick={(e) => e.stopPropagation()}>
                              {row.actions || <span className="text-slate-400">â€”</span>}
                            </div>
                            {row.notes &&
                        <div className="text-xs text-slate-500 dark:text-slate-400 whitespace-pre-wrap text-right">
                                {row.notes}
                              </div>
                        }
                          </div>
                        </td>
                      </tr>
                  )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="md:hidden overflow-y-auto flex-1 min-h-0 space-y-3 p-4" style={{ paddingBottom: navHeight ? navHeight + 8 : 8 }}>
              {rows.map((row, index) =>
            <div
              key={row.id || `${row.itemName}-${index}`}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              role={onRowClick ? "button" : undefined}
              className="rounded-2xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">
              
                  <div className="p-4 border-b border-slate-100 dark:border-slate-700/70">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold text-[15px] leading-5 text-slate-900 dark:text-slate-50">{row.itemName || 'N/A'}</p>
                        <p className="text-xs mt-1 text-slate-500 dark:text-slate-400">{formatDate(row.collectionDate || row.deliveryDate)}</p>
                      </div>
                      <div className="shrink-0 rounded-xl bg-emerald-50 dark:bg-emerald-900/20 px-3 py-2 text-base font-bold leading-none text-emerald-600 dark:text-emerald-400">{formatAmount(row.amount)}</div>
                    </div>
                  </div>

                  <div className="p-4 space-y-3">
                    <div className="grid grid-cols-2 gap-2">
                      <div className="rounded-xl px-3 py-2 col-span-2" style={{ background: 'var(--bg-slate-100, rgba(148,163,184,0.15))' }}>
                        <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--text-slate-500)' }}>Store</div>
                        <div className="mt-1 text-sm font-medium truncate" style={{ color: 'var(--text-slate-900)' }}>{row.storeName || 'Unknown'}</div>
                        {row.subtext && <div className="mt-0.5 text-xs truncate" style={{ color: 'var(--text-slate-500)' }}>{row.subtext}</div>}
                      </div>
                    </div>

                    {showLocationColumn &&
                <div className="rounded-xl px-3 py-2" style={{ background: 'var(--bg-slate-100, rgba(148,163,184,0.15))' }}>
                        <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--text-slate-500)' }}>Square Location ID</div>
                        <div className="mt-1 text-xs font-mono break-all" style={{ color: 'var(--text-slate-700)' }}>{row.locationId || '--'}</div>
                      </div>
                }

                    <div className="rounded-xl px-3 py-2" style={{ background: 'var(--bg-slate-100, rgba(148,163,184,0.15))' }}>
                      <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--text-slate-500)' }}>Transaction ID</div>
                      <div className="mt-1 text-xs font-mono break-all" style={{ color: 'var(--text-slate-700)' }}>{row.catalogId || '--'}</div>
                    </div>

                    {row.notes &&
                <div className="rounded-xl bg-amber-50 dark:bg-amber-900/10 px-3 py-2 text-xs text-slate-700 dark:text-slate-300 whitespace-pre-wrap">
                        {row.notes}
                      </div>
                }

                    {row.actions && <div className="pt-1 flex justify-end">{row.actions}</div>}
                  </div>
                </div>
            )}
            </div>
          </div>
        }
      </CardContent>
    </Card>);

}