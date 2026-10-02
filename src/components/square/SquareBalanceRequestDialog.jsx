import React, { useEffect, useMemo, useState } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2, Send, Wallet } from 'lucide-react';
import { getAppOwners, sendDeliveryMessage, sendPushForNotification } from '@/components/utils/deliveryMessaging';

/**
 * Dispatcher "request more money on the card" dialog, opened by clicking the
 * Square Balances sidebar link (dispatcher-only — admins/owners still navigate
 * straight to the balances page).
 *
 * Sends the App Owner(s) an in-app message + push notification with the
 * requested amount ROUNDED UP to the next $5 mark (an exact multiple stays
 * as-is; $23 → $25, $25 → $25, $25.01 → $30).
 */

const roundUpToFive = (amount) => {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.ceil(n / 5) * 5;
};

export default function SquareBalanceRequestDialog({
  open,
  onOpenChange,
  currentUser,
  appUsers,
  byLocId,
  storeToLoc,
}) {
  const [amount, setAmount] = useState('');
  const [sending, setSending] = useState(false);
  const [sentOk, setSentOk] = useState(false);
  const [error, setError] = useState('');

  // The card is PRESET — it comes from the Square location mapped to the
  // dispatcher's own store (the store they're logged into / assigned to).
  // Dispatchers never pick a card.
  const card = useMemo(() => {
    if (!byLocId) return null;
    const myStoreIds = (currentUser?.store_ids || []).map(String);
    const myLocId = myStoreIds.map((sid) => storeToLoc?.get?.(sid)).find(Boolean);
    const v = myLocId ? byLocId.get(myLocId) : null;
    if (!v) return null;
    return { id: myLocId, name: v?.name || 'Store card', balance: Number(v?.cardEstimate || 0) };
  }, [byLocId, storeToLoc, currentUser]);

  useEffect(() => {
    if (open) { setAmount(''); setSending(false); setSentOk(false); setError(''); }
  }, [open]);

  const entered = Number(String(amount).replace(/[^0-9.]/g, '')) || 0;
  const rounded = roundUpToFive(entered);

  const handleSend = async () => {
    if (!rounded || !card || sending) return;
    setSending(true);
    setError('');
    try {
      const dispatcherName = currentUser?.user_name || currentUser?.full_name || 'Dispatcher';
      const body =
        `${dispatcherName} is requesting a\nSquare card top-up.\n\n` +
        `Card: ${card.name}\n` +
        `Amount: $${rounded}\n` +
        `Current estimated balance: $${Math.round(card.balance).toLocaleString()}`;

      const owners = await getAppOwners(appUsers);
      if (!owners || owners.length === 0) {
        setError('Could not find the App Owner to send this to.');
        setSending(false);
        return;
      }

      let sentCount = 0;
      for (const owner of owners) {
        const receiverId = owner.user_id || owner.id;
        const created = await sendDeliveryMessage({
          senderId: currentUser?.user_id || currentUser?.id,
          senderName: dispatcherName,
          receiverId,
          receiverName: owner.user_name || owner.full_name || 'App Owner',
          content: body,
        }).catch(() => null);
        await sendPushForNotification({
          receiverId,
          senderName: dispatcherName,
          content: body,
          titleOverride: 'Square Card Top-Up Request',
          url: '/squarebalances',
          message_id: created?.id,
        }).catch(() => null);
        sentCount++;
      }

      setSentOk(true);
      setTimeout(() => onOpenChange?.(false), 1400);
    } catch (e) {
      console.error('[SquareBalanceRequest] send failed:', e);
      setError(e?.message || 'Failed to send the request.');
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!sending) onOpenChange?.(v); }}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Wallet className="w-4 h-4" /> Request Card Top-Up</DialogTitle>
          <DialogDescription>
            Sends the App Owner a push notification and in-app message asking for
            more money on your store's Square card. The amount is rounded up to the
            next $5 mark.
          </DialogDescription>
        </DialogHeader>

        {sentOk ? (
          <div className="py-6 text-center text-sm text-emerald-600 dark:text-emerald-400 font-medium">
            Request sent to the App Owner.
          </div>
        ) : (
          <div className="space-y-4 py-1">
            <div className="space-y-1">
              <Label className="text-sm">Store card</Label>
              {card ? (
                <div className="rounded-md border px-3 py-2 text-sm font-medium flex items-center justify-between" style={{ borderColor: 'var(--border-slate-300)' }}>
                  <span>{card.name}</span>
                  <span className="tabular-nums text-muted-foreground">{`~$${Math.round(card.balance).toLocaleString()}`}</span>
                </div>
              ) : (
                <div className="text-xs text-red-500">No Square card is configured for your store.</div>
              )}
            </div>

            <div className="space-y-1">
              <Label className="text-sm">Amount needed (rough)</Label>
              <Input
                type="text"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="e.g. 25"
                disabled={sending}
                className="text-sm"
              />
              {rounded > 0 && (
                <p className="text-xs text-muted-foreground">
                  Will be sent as: <span className="font-semibold tabular-nums">${rounded}</span> (rounded up to the next $5)
                </p>
              )}
            </div>

            {error && <p className="text-xs text-red-500">{error}</p>}
          </div>
        )}

        {!sentOk && (
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => onOpenChange?.(false)} disabled={sending}>Cancel</Button>
            <Button onClick={handleSend} disabled={!rounded || !card || sending} className="gap-2 bg-emerald-600 hover:bg-emerald-700 text-white">
              {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              {sending ? 'Sending…' : 'Send Request'}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
