import React, { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, AlertTriangle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function AuditTable({ title, description, rows, columns, defaultSortKey }) {
  const [sortConfig, setSortConfig] = React.useState({
    key: defaultSortKey,
    direction: "asc",
  });

  const handleSort = (key) => {
    setSortConfig((current) => ({
      key,
      direction: current.key === key && current.direction === "asc" ? "desc" : "asc",
    }));
  };

  const sortedRows = React.useMemo(() => {
    const nextRows = [...(rows || [])];
    const column = columns.find((item) => item.key === sortConfig.key);
    const getSortValue = column?.sortValue || ((row) => row?.[sortConfig.key]);

    nextRows.sort((a, b) => {
      const aValue = getSortValue(a);
      const bValue = getSortValue(b);

      if (aValue == null && bValue == null) return 0;
      if (aValue == null) return 1;
      if (bValue == null) return -1;
      if (aValue < bValue) return sortConfig.direction === "asc" ? -1 : 1;
      if (aValue > bValue) return sortConfig.direction === "asc" ? 1 : -1;
      return 0;
    });

    return nextRows;
  }, [rows, columns, sortConfig]);

  const discrepancyCount = rows.filter((row) => row.hasDiscrepancy).length;

  return (
    <Card className="bg-white border-slate-200 shadow-sm">
      <CardHeader className="space-y-2">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <div>
            <CardTitle className="text-lg text-slate-900">{title}</CardTitle>
            <p className="text-sm text-slate-500">{description}</p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="bg-slate-100 text-slate-700">
              {rows.length} rows
            </Badge>
            {discrepancyCount > 0 && (
              <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-100">
                <AlertTriangle className="mr-1 h-3 w-3" />
                {discrepancyCount} discrepancies
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-sm">
            <thead>
              <tr className="border-b border-slate-200">
                {columns.map((column) => {
                  const isActive = sortConfig.key === column.key;
                  const SortIcon = !isActive ? ArrowUpDown : sortConfig.direction === "asc" ? ArrowUp : ArrowDown;

                  return (
                    <th key={column.key} className="px-3 py-3 text-left font-semibold text-slate-700">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-auto px-0 py-0 font-semibold text-slate-700 hover:bg-transparent"
                        onClick={() => handleSort(column.key)}
                      >
                        {column.label}
                        <SortIcon className="ml-2 h-3.5 w-3.5" />
                      </Button>
                    </th>
                  );
                })}
                <th className="px-3 py-3 text-left font-semibold text-slate-700">Audit Flags</th>
              </tr>
            </thead>
            <tbody>
              {sortedRows.length === 0 ? (
                <tr>
                  <td colSpan={columns.length + 1} className="px-3 py-10 text-center text-slate-500">
                    No rows found.
                  </td>
                </tr>
              ) : (
                sortedRows.map((row) => (
                  <tr
                    key={row.id}
                    className={row.hasDiscrepancy ? "border-b border-amber-200 bg-amber-50/70" : "border-b border-slate-100"}
                  >
                    {columns.map((column) => (
                      <td key={column.key} className="px-3 py-3 align-top text-slate-700">
                        {column.render ? column.render(row) : row[column.key]}
                      </td>
                    ))}
                    <td className="px-3 py-3 align-top">
                      {row.issues?.length ? (
                        <div className="flex flex-wrap gap-1">
                          {row.issues.map((issue) => (
                            <Badge
                              key={issue}
                              variant="outline"
                              className="border-amber-300 bg-white text-amber-800"
                            >
                              {issue}
                            </Badge>
                          ))}
                        </div>
                      ) : (
                        <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100">Matched</Badge>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}