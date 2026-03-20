import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DollarSign, Loader2, Trash2 } from "lucide-react";

const formatDisplayDate = (value) => {
  if (!value) return "—";

  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    const [year, month, day] = String(value).split("-").map(Number);
    return new Date(year, month - 1, day).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";

  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
};

function ActionCell({ row, deletingId, onDeleteCatalogItem }) {
  if (row.actionType !== "delete") {
    return <span className="text-slate-400">—</span>;
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={(event) => {
        event.stopPropagation();
        onDeleteCatalogItem?.(row.raw);
      }}
      disabled={deletingId === row.catalogId}
      className="text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20"
    >
      {deletingId === row.catalogId ? (
        <Loader2 className="w-4 h-4 animate-spin" />
      ) : (
        <Trash2 className="w-4 h-4" />
      )}
    </Button>
  );
}

export default function SquareCODDatasetTable({
  title,
  rows,
  isLoading,
  emptyTitle,
  emptyDescription,
  deletingId,
  onDeleteCatalogItem,
  onSelectRow,
}) {
  return (
    <Card className="bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 flex-1 flex flex-col min-h-0">
      <CardHeader className="sticky top-0 z-10 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-700">
        <CardTitle className="text-base md:text-lg text-slate-900 dark:text-slate-50">{title}</CardTitle>
      </CardHeader>
      <CardContent className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin w-8 h-8 border-4 rounded-full border-slate-300 border-t-transparent" />
          </div>
        ) : rows.length === 0 ? (
          <div className="text-center py-12 text-slate-500 dark:text-slate-400">
            <DollarSign className="w-10 md:w-12 h-10 md:h-12 mx-auto mb-4 opacity-50" />
            <p className="text-sm md:text-base">{emptyTitle}</p>
            <p className="text-xs md:text-sm mt-1">{emptyDescription}</p>
          </div>
        ) : (
          <>
            <div className="hidden md:block overflow-x-auto pb-2">
              <table className="w-full">
                <thead>
                  <tr className="border-b text-left text-sm text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700">
                    <th className="p-3">Item Name</th>
                    <th className="p-3">Amount</th>
                    <th className="p-3">Store</th>
                    <th className="p-3">Square Location ID</th>
                    <th className="p-3">Catalog ID</th>
                    <th className="p-3">Delivery Date</th>
                    <th className="p-3">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr
                      key={row.id}
                      onClick={() => row.isSelectable && onSelectRow?.(row.raw)}
                      className={`border-b border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800/50 ${row.isSelectable ? "cursor-pointer" : ""}`}
                    >
                      <td className="p-3">
                        <div className="font-medium text-sm text-slate-900 dark:text-slate-50">{row.itemName}</div>
                        {row.description ? (
                          <div className="text-xs truncate max-w-[220px] mt-1 text-muted-foreground">{row.description}</div>
                        ) : null}
                        {row.driverBadges?.length ? (
                          <div className="flex gap-1 mt-1.5 flex-wrap">
                            {row.driverBadges.map((badge, index) => (
                              <Badge key={`${row.id}-${badge.label}-${index}`} className={`${badge.className} text-xs border`}>
                                {badge.label}
                              </Badge>
                            ))}
                          </div>
                        ) : null}
                        {row.badges?.length ? (
                          <div className="flex gap-1 mt-1.5 flex-wrap">
                            {row.badges.map((badge, index) => (
                              <Badge key={`${row.id}-${badge.label}-${index}`} className={`${badge.className} text-xs`}>
                                {badge.label}
                              </Badge>
                            ))}
                          </div>
                        ) : null}
                      </td>
                      <td className="p-3">
                        <div className="font-semibold text-sm text-emerald-600 dark:text-emerald-400">
                          ${Number(row.amount || 0).toFixed(2)}
                        </div>
                      </td>
                      <td className="p-3 text-sm text-slate-900 dark:text-slate-50">{row.storeName || "—"}</td>
                      <td className="p-3 text-xs font-mono text-slate-600 dark:text-slate-400">{row.squareLocationId || "—"}</td>
                      <td className="p-3 text-xs font-mono text-slate-600 dark:text-slate-400">{row.catalogId || "—"}</td>
                      <td className="p-3 text-xs text-slate-600 dark:text-slate-400">{formatDisplayDate(row.deliveryDate)}</td>
                      <td className="p-3">
                        <ActionCell row={row} deletingId={deletingId} onDeleteCatalogItem={onDeleteCatalogItem} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="md:hidden space-y-3">
              {rows.map((row) => (
                <div
                  key={row.id}
                  onClick={() => row.isSelectable && onSelectRow?.(row.raw)}
                  role={row.isSelectable ? "button" : undefined}
                  className={`p-3 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 ${row.isSelectable ? "cursor-pointer active:ring-1 active:ring-slate-300" : ""}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-sm text-slate-900 dark:text-slate-50 truncate">{row.itemName}</p>
                      {row.description ? (
                        <p className="text-xs truncate mt-0.5 text-slate-600 dark:text-slate-400">{row.description}</p>
                      ) : null}
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <div className="text-base font-bold leading-none text-emerald-600 dark:text-emerald-400">
                        ${Number(row.amount || 0).toFixed(2)}
                      </div>
                      <ActionCell row={row} deletingId={deletingId} onDeleteCatalogItem={onDeleteCatalogItem} />
                    </div>
                  </div>

                  {row.driverBadges?.length ? (
                    <div className="flex gap-1 mt-2 flex-wrap">
                      {row.driverBadges.map((badge, index) => (
                        <Badge key={`${row.id}-${badge.label}-${index}`} className={`${badge.className} text-[10px] border`}>
                          {badge.label}
                        </Badge>
                      ))}
                    </div>
                  ) : null}

                  {row.badges?.length ? (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {row.badges.map((badge, index) => (
                        <Badge key={`${row.id}-${badge.label}-${index}`} className={`${badge.className} text-xs`}>
                          {badge.label}
                        </Badge>
                      ))}
                    </div>
                  ) : null}

                  <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-slate-600 dark:text-slate-400">
                    <div className="truncate">
                      <span className="font-semibold text-slate-900 dark:text-slate-50">Store:</span> {row.storeName || "—"}
                    </div>
                    <div className="truncate text-right">
                      <span className="font-semibold text-slate-900 dark:text-slate-50">Date:</span> {formatDisplayDate(row.deliveryDate)}
                    </div>
                    <div className="truncate col-span-2">
                      <span className="font-semibold text-slate-900 dark:text-slate-50">Square Location ID:</span> {row.squareLocationId || "—"}
                    </div>
                    <div className="truncate col-span-2">
                      <span className="font-semibold text-slate-900 dark:text-slate-50">Catalog ID:</span> {row.catalogId || "—"}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}