import { useCallback, useEffect, useState } from "react";
import { base44 } from "@/api/base44Client";

/**
 * useManualSwipes — OWNER REQUEST (Nov 22 2026): Square's API cannot see a cart
 * that was swiped but never rung up, so the strip can only show what Square
 * exposes. This hook backs the manual fallback: a store logs the swipe it knows
 * about (amount, card, date) and it stays on the card until a collected
 * delivery matches it or someone dismisses it.
 */
export default function useManualSwipes(enabled) {
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    if (!enabled) return;
    try {
      const page = await base44.entities.PendingCardSwipe.filter({ status: 'open' }, { sort: '-swiped_at', limit: 200 });
      setRows(Array.isArray(page) ? page : (page?.items || []));
    } catch (e) {
      console.warn('[ManualSwipes] load failed:', e?.message || e);
    }
  }, [enabled]);
  useEffect(() => {
    if (!enabled) return;
    load();
    const t = setInterval(load, 120000);
    return () => clearInterval(t);
  }, [enabled, load]);
  const add = useCallback(async (data) => {
    setBusy(true);
    try {
      const rec = await base44.entities.PendingCardSwipe.create({ ...data, status: 'open' });
      setRows((prev) => [rec, ...prev]);
      return rec;
    } finally {
      setBusy(false);
    }
  }, []);
  const close = useCallback(async (id, how, deliveryId = null) => {
    try {
      await base44.entities.PendingCardSwipe.update(id, {
        status: how === 'matched' ? 'cleared' : 'dismissed',
        cleared_by: how,
        cleared_delivery_id: deliveryId || undefined,
        cleared_at: new Date().toISOString()
      });
      setRows((prev) => prev.filter((r) => String(r.id) !== String(id)));
    } catch (e) {
      console.warn('[ManualSwipes] close failed:', e?.message || e);
    }
  }, []);
  return { rows, busy, add, close, reload: load };
}