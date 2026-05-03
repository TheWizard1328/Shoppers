import React from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const statusStyles = {
  idle: "bg-slate-100 text-slate-700",
  running: "bg-blue-100 text-blue-700",
  success: "bg-emerald-100 text-emerald-700",
  warning: "bg-amber-100 text-amber-700",
  error: "bg-red-100 text-red-700",
};

export default function SyncHealthPanel({ runs = [], logs = [] }) {
  const latestRun = runs[0];

  return (
    <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
      <Card className="shadow-sm">
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Sync Health</h2>
            {latestRun?.status && (
              <Badge className={statusStyles[latestRun.status] || statusStyles.idle}>{latestRun.status}</Badge>
            )}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <div><div className="text-slate-500">Requests</div><div className="font-semibold">{latestRun?.request_count ?? 0}</div></div>
            <div><div className="text-slate-500">Retries</div><div className="font-semibold">{latestRun?.retry_count ?? 0}</div></div>
            <div><div className="text-slate-500">Rate Limits</div><div className="font-semibold">{latestRun?.rate_limit_hits ?? 0}</div></div>
            <div><div className="text-slate-500">Errors</div><div className="font-semibold">{latestRun?.error_count ?? 0}</div></div>
          </div>
          <div className="text-sm text-slate-600">{latestRun?.summary || "No sync run recorded yet."}</div>
        </CardContent>
      </Card>

      <Card className="shadow-sm">
        <CardContent className="p-4 space-y-3">
          <h2 className="text-sm font-semibold">Recent Sync Logs</h2>
          <div className="space-y-2 max-h-64 overflow-auto">
            {logs.length === 0 ? (
              <div className="text-sm text-slate-500">No logs yet.</div>
            ) : logs.map((log) => (
              <div key={log.id} className="rounded-lg border p-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <Badge className={statusStyles[log.level === 'error' ? 'error' : log.level === 'warn' ? 'warning' : 'idle']}>{log.level}</Badge>
                  <div className="text-xs text-slate-500">{log.logged_at ? new Date(log.logged_at).toLocaleString() : ""}</div>
                </div>
                <div className="mt-2 font-medium">{log.step || "sync"}</div>
                <div className="text-slate-600">{log.message}</div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}