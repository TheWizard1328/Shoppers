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
  const [filters, setFilters] = useState({});

  const handleSort = (key) => {
    setSortConfig((current) => ({
      key,
      direction: current.key === key && current.direction === "asc" ? "desc" : "asc",
    }));
  };

  const filteredRows = useMemo(() => {
    return (rows || []).filter((row) => {
      return columns.every((column) => {
        const filterValue = String(filters[column.key] || "").trim().toLowerCase();
        if (!filterValue) return true;
        const rawValue = column.filterValue ? column.filterValue(row) : row?.[column.key];
        return String(rawValue ?? "").toLowerCase().includes(filterValue);
      });
    });
  }, [rows, columns, filters]);

  const sortedRows = React.useMemo(() => {
    const nextRows = [...filteredRows];
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
  }, [filteredRows, columns, sortConfig]);

  const discrepancyCount = rows.filter((row) => row.hasDiscrepancy).length;

  return (
    <Card className="shadow-sm overflow-hidden" style={{ background: "var(--bg-white)", borderColor: "var(--border-slate-200)" }}>
      <CardHeader className="space-y-2">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <div>
            <CardTitle className="text-lg" style={{ color: "var(--text-slate-900)" }}>{title}</CardTitle>
            <p className="text-sm" style={{ color: "var(--text-slate-500)" }}>{description}</p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="border" style={{ background: "var(--bg-slate-100)", color: "var(--text-slate-700)", borderColor: "var(--border-slate-200)" }}>
              {sortedRows.length} / {rows.length} rows
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
      <CardContent className="p-0">
        <div className="max-h-[62vh] overflow-auto">
          <table className="w-full min-w-max text-sm">
            <thead className="sticky top-0 z-10" style={{ background: "var(--bg-white)" }}>
              <tr style={{ borderBottom: "1px solid var(--border-slate-200)" }}>
                {columns.map((column) => {
                  const isActive = sortConfig.key === column.key;
                  const SortIcon = !isActive ? ArrowUpDown : sortConfig.direction === "asc" ? ArrowUp : ArrowDown;

                  return (
                    <th key={column.key} className={`px-3 py-3 text-left font-semibold ${column.headerClassName || ""}`} style={{ color: "var(--text-slate-700)" }}>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-auto px-0 py-0 font-semibold hover:bg-transparent"
                        style={{ color: "var(--text-slate-700)" }}
                        onClick={() => handleSort(column.key)}
                      >
                        {column.label}
                        <SortIcon className="ml-2 h-3.5 w-3.5" />
                      </Button>
                    </th>
                  );
                })}
                <th className="px-3 py-3 text-left font-semibold whitespace-nowrap" style={{ color: "var(--text-slate-700)" }}>Audit Flags</th>
              </tr>
              <tr style={{ borderBottom: "1px solid var(--border-slate-200)" }}>
                {columns.map((column) => (
                  <th key={`${column.key}-filter`} className={`px-3 pb-3 ${column.headerClassName || ""}`}>
                    <Input
                      value={filters[column.key] || ""}
                      onChange={(event) => setFilters((current) => ({ ...current, [column.key]: event.target.value }))}
                      placeholder={`Filter ${column.label}`}
                      className={`h-8 ${column.filterClassName || ""}`}
                    />
                  </th>
                ))}
                <th className="px-3 pb-3 text-right">
                  <Button variant="ghost" size="sm" className="h-8 px-2 text-xs" onClick={() => setFilters({})}>
                    Clear
                  </Button>
                </th>
              </tr>
            </thead>
            <tbody>
              {sortedRows.length === 0 ? (
                <tr>
                  <td colSpan={columns.length + 1} className="px-3 py-10 text-center" style={{ color: "var(--text-slate-500)" }}>
                    No rows found.
                  </td>
                </tr>
              ) : (
                sortedRows.map((row) => (
                  <tr
                    key={row.id}
                    style={{
                      borderBottom: row.hasDiscrepancy ? "1px solid rgb(253 230 138)" : "1px solid var(--border-slate-200)",
                      background: row.hasDiscrepancy ? "rgba(251, 191, 36, 0.12)" : "transparent",
                    }}
                  >
                    {columns.map((column) => (
                      <td key={column.key} className={`px-3 py-3 align-top ${column.cellClassName || ""}`} style={{ color: "var(--text-slate-700)" }}>
                        {column.render ? column.render(row) : row[column.key]}
                      </td>
                    ))}
                    <td className="px-3 py-3 align-top min-w-[220px]">
                      {row.issues?.length ? (
                        <div className="flex flex-wrap gap-1">
                          {row.issues.map((issue) => (
                            <Badge
                              key={issue}
                              variant="outline"
                              className="border-amber-300 text-amber-800"
                              style={{ background: "var(--bg-white)" }}
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