import React, { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DollarSign, ChevronDown } from "lucide-react";
import { hexToRgba } from "@/components/utils/colorGenerator";

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
index].
filter(Boolean).join("|");

const isRowCollected = (row) => {
  const cls = row.actions?.props?.className || '';
  // "Collected" buttons have bg-emerald-100 (light) or bg-emerald-900/40 (dark) — never bg-white.
  // "Collect" (pending) buttons use bg-white, so we check for bg-white to exclude them.
  if (cls.includes('bg-white') || cls.includes('dark:bg-slate-900')) return false;
  return cls.includes('bg-emerald-100') || cls.includes('bg-emerald-900');
};

const DesktopRow = ({ row, index, onRowClick, showLocationColumn, showCatalogColumn, dimmed }) => {
  const driverColor = row.driverColor || null;
  const rowStyle = driverColor ? { borderLeft: `3px solid ${driverColor}`, background: hexToRgba(driverColor, 0.03) } : {};
  return (
    <tr
      key={getRowKey(row, index)}
      onClick={onRowClick ? () => onRowClick(row) : undefined}
      style={rowStyle}
      className={`transition-colors border-b border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800/50${dimmed ? ' opacity-60' : ''}`}>
      <td className="p-3 min-w-[180px]">
        <div className="font-medium text-sm text-slate-900 dark:text-slate-50 whitespace-nowrap">{row.itemName || 'N/A'}</div>
        <div className="text-xs mt-1 text-slate-500 dark:text-slate-400">{formatDate(row.collectionDate || row.deliveryDate)}</div>
      </td>
      <td className="p-3 whitespace-nowrap">
        <div className="text-sm font-semibold text-emerald-600 dark:text-emerald-400">{formatAmount(row.amount)}</div>
        {row.collectionType &&
          <div className={`inline-flex mt-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${String(row.collectionType).toLowerCase().includes('cash') ? 'border-emerald-200 dark:border-emerald-800 bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300' : 'border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300'}`}>
            {row.collectionType}
          </div>
        }
      </td>
      <td className="p-3 whitespace-nowrap">
        <div className="text-sm text-slate-900 dark:text-slate-50">{row.storeName || 'Unknown'}</div>
      </td>
      {showLocationColumn &&
        <td className="p-3">
          <div className="text-xs font-mono text-slate-600 dark:text-slate-400 whitespace-nowrap">
            {row.locationId || '--'}
          </div>
        </td>
      }
      <td className="p-3">
        <div className="text-xs font-mono text-slate-600 dark:text-slate-400 whitespace-nowrap">
          {row.catalogId || '--'}
        </div>
      </td>
      <td className="p-3">
        <div className="text-xs font-mono text-slate-600 dark:text-slate-400 whitespace-nowrap">
          {row.transactionId ? (row.transactionId.includes(':') ? row.transactionId.split(':')[0] : row.transactionId) : '--'}
        </div>
      </td>
      <td className="p-3">
        <div className="space-y-1">
          <div className="flex justify-start [&>button]:w-24 [&>div>button]:w-24" onClick={(e) => e.stopPropagation()}>
            {row.actions || <span className="text-slate-400">—</span>}
          </div>
          {row.notes &&
            <div className="text-xs text-slate-500 dark:text-slate-400 whitespace-pre-wrap text-right">{row.notes}</div>
          }
        </div>
      </td>
    </tr>
  );
};


const SectionDivider = ({ label, colSpan }) =>
<tr>
    <td colSpan={colSpan} className="px-3 py-2 bg-slate-50 dark:bg-slate-800/60 border-y border-slate-200 dark:border-slate-700">
      <div className="flex items-center gap-2 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
        <div className="flex-1 h-px bg-slate-300 dark:bg-slate-600" />
        <span>{label}</span>
        <div className="flex-1 h-px bg-slate-300 dark:bg-slate-600" />
      </div>
    </td>
  </tr>;


const MobileCard = ({ row, index, onRowClick, showLocationColumn, showCatalogColumn, dimmed }) => {
  const [expanded, setExpanded] = useState(false);
  const actionClassName = row.actions?.props?.className || '';
  const isCollected = actionClassName.includes('emerald');

  const handleClick = () => {
    if (onRowClick) onRowClick(row);
    else setExpanded((prev) => !prev);
  };

  const driverColor = row.driverColor || null;
  const cardBorderStyle = driverColor ? { borderLeftColor: driverColor, borderLeftWidth: 3, background: hexToRgba(driverColor, 0.03) } : {};
  return (
    <div
      key={row.id || `${row.itemName}-${index}`}
      style={cardBorderStyle}
      className={`rounded-2xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden${dimmed ? ' opacity-60' : ''}`}>
      {/* Collapsed summary row — always visible */}
      <div
        onClick={handleClick}
        role="button"
        className="flex items-center gap-3 px-4 py-3 cursor-pointer select-none">
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-[14px] leading-5 text-slate-900 dark:text-slate-50 truncate">{row.itemName || 'N/A'}</p>
          <p className="text-xs mt-0.5 text-slate-500 dark:text-slate-400">{formatDate(row.collectionDate || row.deliveryDate)}</p>
        </div>
        <div className="shrink-0 text-base font-bold text-emerald-600 dark:text-emerald-400">{formatAmount(row.amount)}</div>
        {showCatalogColumn
          ? <div className="shrink-0" onClick={(e) => e.stopPropagation()}>{row.actions || null}</div>
          : isCollected
            ? <span className="shrink-0 rounded-full bg-emerald-100 dark:bg-emerald-900/30 border border-emerald-300 dark:border-emerald-700 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">Collected</span>
            : <span className="shrink-0 rounded-full bg-amber-100 dark:bg-amber-900/30 border border-amber-300 dark:border-amber-700 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300">Pending</span>
        }
        <ChevronDown className={`shrink-0 w-4 h-4 text-slate-400 transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`} />
      </div>

      {/* Expanded detail section */}
      {expanded && (
        <div className="border-t border-slate-100 dark:border-slate-700/70 p-4 space-y-3">
          <div className="rounded-xl px-3 py-2" style={{ background: 'var(--bg-slate-100, rgba(148,163,184,0.15))' }}>
            <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--text-slate-500)' }}>Store</div>
            <div className="mt-1 text-sm font-medium truncate" style={{ color: 'var(--text-slate-900)' }}>{row.storeName || 'Unknown'}</div>
            {row.subtext && <div className="mt-0.5 text-xs truncate" style={{ color: 'var(--text-slate-500)' }}>{row.subtext}</div>}
          </div>
          {showLocationColumn &&
            <div className="rounded-xl px-3 py-2" style={{ background: 'var(--bg-slate-100, rgba(148,163,184,0.15))' }}>
              <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--text-slate-500)' }}>Square Location ID</div>
              <div className="mt-1 text-xs font-mono break-all" style={{ color: 'var(--text-slate-700)' }}>
                {row.locationId || '--'}
              </div>
            </div>
          }
          <div className="rounded-xl px-3 py-2" style={{ background: 'var(--bg-slate-100, rgba(148,163,184,0.15))' }}>
            <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--text-slate-500)' }}>Catalog ID</div>
            <div className="mt-1 text-xs font-mono break-all" style={{ color: 'var(--text-slate-700)' }}>
              {row.catalogId || '--'}
            </div>
          </div>
          <div className="rounded-xl px-3 py-2" style={{ background: 'var(--bg-slate-100, rgba(148,163,184,0.15))' }}>
            <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--text-slate-500)' }}>Transaction ID</div>
            <div className="mt-1 text-xs font-mono break-all" style={{ color: 'var(--text-slate-700)' }}>
              {row.transactionId ? (row.transactionId.includes(':') ? row.transactionId.split(':')[0] : row.transactionId) : '--'}
            </div>
          </div>
          {row.notes &&
            <div className="rounded-xl bg-amber-50 dark:bg-amber-900/10 px-3 py-2 text-xs text-slate-700 dark:text-slate-300 whitespace-pre-wrap">
              {row.notes}
            </div>
          }
          {row.actions && !showCatalogColumn && <div className="pt-1 flex justify-end" onClick={(e) => e.stopPropagation()}>{row.actions}</div>}
        </div>
      )}
    </div>
  );
};


export default function SquareCodDatasetTable({
  title,
  rows,
  isLoading,
  emptyTitle,
  emptyDescription,
  showLocationColumn,
  navHeight,
  onRowClick,
  groupByCollected,
  showCatalogColumn,
  headerActions,
  newCatalogRows
}) {
  const notCollected = groupByCollected ? rows.filter((r) => !isRowCollected(r)) : rows;
  const collected = groupByCollected ? rows.filter((r) => isRowCollected(r)) : [];
  const hasNewCatalogRows = newCatalogRows && newCatalogRows.length > 0;
  const colSpan = showLocationColumn ? 7 : 6;

  return (
    <Card className="bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 flex flex-col md:flex-1 md:min-h-0">
      <CardHeader className="sticky top-0 z-10 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-700 flex-shrink-0">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-base md:text-lg text-slate-900 dark:text-slate-50">{title}</CardTitle>
          {headerActions && <div className="flex items-center gap-2 ml-auto">{headerActions}</div>}
        </div>
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
            {/* Desktop */}
            <div className="hidden md:flex flex-col flex-1 min-h-0 overflow-hidden">
              <div className="min-h-0 flex-1 overflow-y-auto overflow-x-auto" style={{ paddingBottom: navHeight ? navHeight + 8 : 8 }}>
                <table className="w-full table-auto">
                  <thead className="sticky top-0 z-10 bg-white dark:bg-slate-900">
                    <tr className="border-b text-left text-sm text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700">
                      <th className="p-3 whitespace-nowrap">Item Name</th>
                      <th className="p-3 whitespace-nowrap">Amount</th>
                      <th className="p-3 whitespace-nowrap">Store</th>
                      {showLocationColumn && <th className="p-3 whitespace-nowrap">Square Location ID</th>}
                      <th className="p-3 whitespace-nowrap">Catalog ID</th>
                      <th className="p-3 whitespace-nowrap">Transaction ID</th>
                      <th className="p-3 whitespace-nowrap">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {hasNewCatalogRows &&
                  <SectionDivider label={`New Catalog Items (${newCatalogRows.length})`} colSpan={colSpan} />
                  }
                    {hasNewCatalogRows && newCatalogRows.map((row, index) =>
                  <DesktopRow key={getRowKey(row, index)} row={row} index={index} onRowClick={onRowClick} showLocationColumn={showLocationColumn} showCatalogColumn={showCatalogColumn} />
                  )}
                    {groupByCollected && notCollected.length > 0 &&
                  <SectionDivider label={`Not Collected (${notCollected.length})`} colSpan={colSpan} />
                  }
                    {notCollected.map((row, index) =>
                  <DesktopRow key={getRowKey(row, index)} row={row} index={index} onRowClick={onRowClick} showLocationColumn={showLocationColumn} showCatalogColumn={showCatalogColumn} />
                  )}
                    {groupByCollected && collected.length > 0 &&
                  <SectionDivider label={`Collected (${collected.length})`} colSpan={colSpan} />
                  }
                    {collected.map((row, index) =>
                  <DesktopRow key={getRowKey(row, notCollected.length + index)} row={row} index={notCollected.length + index} onRowClick={onRowClick} showLocationColumn={showLocationColumn} showCatalogColumn={showCatalogColumn} dimmed />
                  )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Mobile */}
            <div className="md:hidden overflow-y-auto flex-1 min-h-0 space-y-3 p-4" style={{ paddingBottom: navHeight ? navHeight + 8 : 8 }}>
              {hasNewCatalogRows &&
            <div className="flex items-center gap-2 text-xs font-semibold text-blue-500 dark:text-blue-400 uppercase tracking-wider py-1">
                  <div className="flex-1 h-px bg-blue-300 dark:bg-blue-600" />
                  <span>New Catalog Items ({newCatalogRows.length})</span>
                  <div className="flex-1 h-px bg-blue-300 dark:bg-blue-600" />
                </div>
            }
              {hasNewCatalogRows && newCatalogRows.map((row, index) =>
            <MobileCard key={row.id || `${row.itemName}-new-${index}`} row={row} index={index} onRowClick={onRowClick} showLocationColumn={showLocationColumn} showCatalogColumn={showCatalogColumn} />
            )}
              {groupByCollected && notCollected.length > 0 &&
            <div className="flex items-center gap-2 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider py-1">
                  <div className="flex-1 h-px bg-slate-300 dark:bg-slate-600" />
                  <span>Not Collected ({notCollected.length})</span>
                  <div className="flex-1 h-px bg-slate-300 dark:bg-slate-600" />
                </div>
            }
              {notCollected.map((row, index) =>
            <MobileCard key={row.id || `${row.itemName}-${index}`} row={row} index={index} onRowClick={onRowClick} showLocationColumn={showLocationColumn} showCatalogColumn={showCatalogColumn} />
            )}
              {groupByCollected && collected.length > 0 &&
            <div className="flex items-center gap-2 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider py-1 mt-2">
                  <div className="flex-1 h-px bg-slate-300 dark:bg-slate-600" />
                  <span>Collected ({collected.length})</span>
                  <div className="flex-1 h-px bg-slate-300 dark:bg-slate-600" />
                </div>
            }
              {collected.map((row, index) =>
            <MobileCard key={row.id || `${row.itemName}-${notCollected.length + index}`} row={row} index={notCollected.length + index} onRowClick={onRowClick} showLocationColumn={showLocationColumn} showCatalogColumn={showCatalogColumn} dimmed />
            )}
            </div>
          </div>
        }
      </CardContent>
    </Card>);

}