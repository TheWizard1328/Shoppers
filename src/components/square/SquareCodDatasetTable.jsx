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

const isRowCollected = (row) => {
  const cls = row.actions?.props?.className || '';
  return cls.includes('emerald');
};

const DesktopRow = ({ row, index, onRowClick, showLocationColumn, showCatalogColumn, dimmed }) => (
  <tr
    key={getRowKey(row, index)}
    onClick={onRowClick ? () => onRowClick(row) : undefined}
    className={`transition-colors border-b border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800/50${dimmed ? ' opacity-60' : ''}`}>
    <td className="p-3">
      <div className="font-medium text-sm text-slate-900 dark:text-slate-50">{row.itemName || 'N/A'}</div>
      <div className="text-xs mt-1 text-slate-500 dark:text-slate-400">{formatDate(row.collectionDate || row.deliveryDate)}</div>
    </td>
    <td className="p-3">
      <div className="text-sm font-semibold text-emerald-600 dark:text-emerald-400">{formatAmount(row.amount)}</div>
      {row.collectionType && (
        <div className={`inline-flex mt-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${String(row.collectionType).toLowerCase().includes('cash') ? 'border-emerald-200 dark:border-emerald-800 bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300' : 'border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300'}`}>
          {row.collectionType}
        </div>
      )}
    </td>
    <td className="p-3">
      <div className="text-sm text-slate-900 dark:text-slate-50">{row.storeName || 'Unknown'}</div>
      {row.subtext && <div className="text-xs mt-1 text-slate-500 dark:text-slate-400">{row.subtext}</div>}
    </td>
    {showLocationColumn && (
      <td className="p-3">
        <div className="text-xs font-mono truncate max-w-[180px] text-slate-600 dark:text-slate-400">
          {showCatalogColumn ? (row.catalogId || '--') : (row.locationId || '--')}
        </div>
      </td>
    )}
    <td className="p-3">
      <div className="text-xs font-mono truncate max-w-[150px] text-slate-600 dark:text-slate-400">
        {showCatalogColumn ? (row.transactionId || '--') : (row.catalogId || '--')}
      </div>
    </td>
    <td className="p-3">
      <div className="space-y-1">
        <div className="flex justify-start" onClick={(e) => e.stopPropagation()}>
          {row.actions || <span className="text-slate-400">—</span>}
        </div>
        {row.notes && (
          <div className="text-xs text-slate-500 dark:text-slate-400 whitespace-pre-wrap text-right">{row.notes}</div>
        )}
      </div>
    </td>
  </tr>
);

const SectionDivider = ({ label, colSpan }) => (
  <tr>
    <td colSpan={colSpan} className="px-3 py-2 bg-slate-50 dark:bg-slate-800/60 border-y border-slate-200 dark:border-slate-700">
      <div className="flex items-center gap-2 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
        <div className="flex-1 h-px bg-slate-300 dark:bg-slate-600" />
        <span>{label}</span>
        <div className="flex-1 h-px bg-slate-300 dark:bg-slate-600" />
      </div>
    </td>
  </tr>
);

const MobileCard = ({ row, index, onRowClick, showLocationColumn, showCatalogColumn, dimmed }) => (
  <div
    key={row.id || `${row.itemName}-${index}`}
    onClick={onRowClick ? () => onRowClick(row) : undefined}
    role={onRowClick ? "button" : undefined}
    className={`overflow-hidden${dimmed ? ' opacity-50' : ''}`}
    style={{
      background: '#FAF6F0',
      border: '1px solid #E6DFD5',
      borderRadius: '12px',
      boxShadow: '0 1px 4px rgba(28,26,23,0.07)'
    }}>
    {/* Card Header */}
    <div className="px-4 pt-4 pb-3" style={{ borderBottom: '1px solid #E6DFD5' }}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-[15px] leading-snug" style={{ color: '#1C1A17', fontFamily: 'Georgia, serif' }}>
            {row.itemName || 'N/A'}
          </p>
          <p className="text-xs mt-1" style={{ color: '#8C7B6B', letterSpacing: '0.01em' }}>
            {formatDate(row.collectionDate || row.deliveryDate)}
          </p>
        </div>
        <div className="shrink-0 px-3 py-1.5 rounded-lg" style={{ background: '#EDF7EF', border: '1px solid #B7DEC0' }}>
          <span className="text-base font-bold" style={{ color: '#2D7A3A', fontFamily: 'Georgia, serif' }}>
            {formatAmount(row.amount)}
          </span>
        </div>
      </div>
    </div>

    {/* Card Body */}
    <div className="px-4 py-3 space-y-2.5">
      {/* Store + Driver row */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] uppercase tracking-widest font-semibold mb-0.5" style={{ color: '#8C7B6B' }}>Store</div>
          <div className="text-sm font-medium truncate" style={{ color: '#1C1A17' }}>{row.storeName || 'Unknown'}</div>
          {row.subtext && (
            <div className="text-xs mt-0.5 truncate" style={{ color: '#8C7B6B' }}>{row.subtext}</div>
          )}
        </div>
        {row.collectionType && (
          <div className="shrink-0 px-2 py-0.5 rounded-full text-[11px] font-medium" style={{ background: '#F0EAE1', border: '1px solid #D6C9BC', color: '#5C4F3D' }}>
            {row.collectionType}
          </div>
        )}
      </div>

      {/* ID fields — only show if meaningful */}
      {showLocationColumn && (
        <div>
          <div className="text-[10px] uppercase tracking-widest font-semibold mb-0.5" style={{ color: '#8C7B6B' }}>
            {showCatalogColumn ? 'Catalog ID' : 'Location ID'}
          </div>
          <div className="text-xs font-mono truncate" style={{ color: '#5C4F3D' }}>
            {showCatalogColumn ? (row.catalogId || '—') : (row.locationId || '—')}
          </div>
        </div>
      )}

      {row.notes && (
        <div className="px-3 py-2 rounded-lg text-xs whitespace-pre-wrap" style={{ background: '#FDF3E3', border: '1px solid #EDD9A3', color: '#7A5C1E' }}>
          {row.notes}
        </div>
      )}

      {/* Action button — full width, prominent */}
      {row.actions && (
        <div className="pt-1" onClick={(e) => e.stopPropagation()}>
          {row.actions}
        </div>
      )}
    </div>
  </div>
);

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
  showCatalogColumn
}) {
  const notCollected = groupByCollected ? rows.filter((r) => !isRowCollected(r)) : rows;
  const collected = groupByCollected ? rows.filter((r) => isRowCollected(r)) : [];
  const colSpan = showLocationColumn ? 6 : 5;

  return (
    <Card className="flex flex-col md:flex-1 md:min-h-0 md:bg-white md:dark:bg-slate-900 md:border-slate-200 md:dark:border-slate-700" style={{ background: '#F5EFE7', border: 'none', borderRadius: 0, boxShadow: 'none' }}>
      <CardHeader className="sticky top-0 z-10 flex-shrink-0 hidden md:flex" style={{ background: '#FFFFFF', borderBottom: '1px solid #E6DFD5' }}>
        <CardTitle className="text-base md:text-lg text-slate-900 dark:text-slate-50">{title}</CardTitle>
      </CardHeader>
      {/* Mobile section label */}
      <div className="md:hidden px-5 pt-3 pb-1 flex-shrink-0">
        <span className="text-[10px] uppercase tracking-widest font-semibold" style={{ color: '#8C7B6B' }}>{title}</span>
      </div>
      <CardContent className="p-0 overflow-hidden flex flex-col md:flex-1 md:min-h-0">
        {isLoading ? (
          <div className="flex items-center justify-center py-12 px-6">
            <div className="animate-spin w-8 h-8 border-4 rounded-full" style={{ borderColor: 'var(--border-emerald-500)', borderTopColor: 'transparent' }} />
          </div>
        ) : rows.length === 0 ? (
          <div className="text-center py-12 px-6 text-slate-500 dark:text-slate-400">
            <DollarSign className="w-10 md:w-12 h-10 md:h-12 mx-auto mb-4 opacity-50" />
            <p className="text-sm md:text-base">{emptyTitle}</p>
            {emptyDescription && <p className="text-xs md:text-sm mt-1">{emptyDescription}</p>}
          </div>
        ) : (
          <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
            {/* Desktop */}
            <div className="hidden md:flex flex-col flex-1 min-h-0 overflow-hidden">
              <div className="overflow-x-auto px-0">
                <table className="w-full table-fixed">
                  <thead className="bg-white dark:bg-slate-900">
                    <tr className="border-b text-left text-sm text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700">
                      <th className="p-3">Item Name</th>
                      <th className="p-3">Amount</th>
                      <th className="p-3">Store</th>
                      {showLocationColumn && <th className="p-3">{showCatalogColumn ? 'Catalog Item ID' : 'Square Location ID'}</th>}
                      <th className="p-3">Transaction ID</th>
                      <th className="p-3">Actions</th>
                    </tr>
                  </thead>
                </table>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto overflow-x-auto" style={{ paddingBottom: navHeight ? navHeight + 8 : 8 }}>
                <table className="w-full table-fixed">
                  <tbody>
                    {groupByCollected && notCollected.length > 0 && (
                      <SectionDivider label={`Not Collected (${notCollected.length})`} colSpan={colSpan} />
                    )}
                    {notCollected.map((row, index) => (
                     <DesktopRow key={getRowKey(row, index)} row={row} index={index} onRowClick={onRowClick} showLocationColumn={showLocationColumn} showCatalogColumn={showCatalogColumn} />
                    ))}
                    {groupByCollected && collected.length > 0 && (
                     <SectionDivider label={`Collected (${collected.length})`} colSpan={colSpan} />
                    )}
                    {collected.map((row, index) => (
                     <DesktopRow key={getRowKey(row, notCollected.length + index)} row={row} index={notCollected.length + index} onRowClick={onRowClick} showLocationColumn={showLocationColumn} showCatalogColumn={showCatalogColumn} dimmed />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Mobile */}
            <div className="md:hidden overflow-y-auto flex-1 min-h-0 space-y-3 px-4 pt-3" style={{ paddingBottom: navHeight ? navHeight + 16 : 16, background: '#F5EFE7' }}>
              {groupByCollected && notCollected.length > 0 && (
                <div className="flex items-center gap-2 py-1">
                  <div className="flex-1 h-px" style={{ background: '#D6C9BC' }} />
                  <span className="text-[10px] uppercase tracking-widest font-semibold px-1" style={{ color: '#8C7B6B' }}>
                    Pending · {notCollected.length}
                  </span>
                  <div className="flex-1 h-px" style={{ background: '#D6C9BC' }} />
                </div>
              )}
              {notCollected.map((row, index) => (
                <MobileCard key={row.id || `${row.itemName}-${index}`} row={row} index={index} onRowClick={onRowClick} showLocationColumn={showLocationColumn} showCatalogColumn={showCatalogColumn} />
              ))}
              {groupByCollected && collected.length > 0 && (
                <div className="flex items-center gap-2 py-1 mt-2">
                  <div className="flex-1 h-px" style={{ background: '#D6C9BC' }} />
                  <span className="text-[10px] uppercase tracking-widest font-semibold px-1" style={{ color: '#8C7B6B' }}>
                    Collected · {collected.length}
                  </span>
                  <div className="flex-1 h-px" style={{ background: '#D6C9BC' }} />
                </div>
              )}
              {collected.map((row, index) => (
                <MobileCard key={row.id || `${row.itemName}-${notCollected.length + index}`} row={row} index={notCollected.length + index} onRowClick={onRowClick} showLocationColumn={showLocationColumn} showCatalogColumn={showCatalogColumn} dimmed />
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}