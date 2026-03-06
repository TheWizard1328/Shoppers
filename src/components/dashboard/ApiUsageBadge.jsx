import React, { useEffect, useState } from "react";
import { base44 } from "@/api/base44Client";

// Small self-contained badge that shows Google/HERE API usage for today
// Props:
// - currentUser: object (used by parent to gate rendering)
// - stopCardsHeight: number (px) to position the badge just above stop cards
export default function ApiUsageBadge({ currentUser, stopCardsHeight = 0 }) {
  const [googleCount, setGoogleCount] = useState(null);
  const [hereCount, setHereCount] = useState(null);

  // Edmonton-local date helpers (match Dashboard behavior)
  const getEdmDate = () => {
    const p = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Edmonton",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
    const y = p.find((x) => x.type === "year").value;
    const m = p.find((x) => x.type === "month").value;
    const d = p.find((x) => x.type === "day").value;
    return `${y}-${m}-${d}`;
  };

  const getDayBoundsISO = () => {
    const dateStr = getEdmDate();
    const start = new Date(`${dateStr}T00:00:00`);
    const end = new Date(`${dateStr}T23:59:59`);
    return { startISO: start.toISOString(), endISO: end.toISOString() };
  };

  const fetchCounts = async () => {
    try {
      const { startISO, endISO } = getDayBoundsISO();

      // Google API usage: count GoogleAPILog entries for today
      const googleLogs = await base44.entities.GoogleAPILog.filter({
        timestamp: { $gte: startISO, $lte: endISO },
      });
      setGoogleCount(Array.isArray(googleLogs) ? googleLogs.length : 0);

      // HERE API usage (approx.): count unique DriverRoutePolyline generated today
      // via either record creation (created_date) or regeneration (last_generated_at)
      const created = await base44.entities.DriverRoutePolyline.filter({
        created_date: { $gte: startISO, $lte: endISO },
      });
      let updated = [];
      try {
        updated = await base44.entities.DriverRoutePolyline.filter({
          last_generated_at: { $gte: startISO, $lte: endISO },
        });
      } catch (_) {
        // last_generated_at filter may not exist on all records; ignore errors silently
      }

      const idSet = new Set([
        ...(Array.isArray(created) ? created.map((p) => p.id) : []),
        ...(Array.isArray(updated) ? updated.map((p) => p.id) : []),
      ]);
      setHereCount(idSet.size);
    } catch (err) {
      // Non-critical; keep previous values
      console.warn("[ApiUsageBadge] Failed to fetch counts:", err?.message || err);
    }
  };

  useEffect(() => {
    // Initial fetch shortly after mount
    const t = setTimeout(fetchCounts, 1000);

    // Refresh on smart refresh completion
    const onSmart = () => fetchCounts();
    window.addEventListener("smartRefreshComplete", onSmart);

    // Periodic refresh every 5 minutes
    const iv = setInterval(fetchCounts, 300000);

    return () => {
      clearTimeout(t);
      clearInterval(iv);
      window.removeEventListener("smartRefreshComplete", onSmart);
    };
  }, []);

  return (
    <div
      className="absolute left-4 z-[140]"
      style={{ bottom: `${(stopCardsHeight || 0) + 15}px` }}
    >
      <div
        className="px-2 py-1 text-xs font-medium rounded-lg border"
        style={{
          background: "transparent",
          borderColor: "var(--border-slate-200)",
          color: "var(--text-slate-600)",
        }}
      >
        🛣️ {googleCount ?? "..."} / {hereCount ?? "..."}
      </div>
    </div>
  );
}