import React, { useState, useEffect } from 'react';
import { Loader2, Plus } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { applyTemplateUpdate } from '@/components/utils/notificationRules';
import NotificationFormatPanel from './NotificationFormatPanel';
import NotificationRulesPanel from './NotificationRulesPanel';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export default function MessageRulesManager() {
  const [records, setRecords] = useState({});
  const [isLoading, setIsLoading] = useState(true);
  const [currentUser, setCurrentUser] = useState(null);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [newEventName, setNewEventName] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [isCreating, setIsCreating] = useState(false);

  useEffect(() => {
    loadTemplates();
    base44.auth.me().then(u => setCurrentUser(u)).catch(() => {});

    const unsubscribe = base44.entities.NotificationTemplate.subscribe((event) => {
      if (!event?.data?.event_name) return;
      setRecords(prev => {
        if (event.type === 'delete') {
          const next = { ...prev };
          delete next[event.data.event_name];
          return next;
        }
        return { ...prev, [event.data.event_name]: { ...(prev[event.data.event_name] || {}), ...event.data } };
      });
    });

    return () => { try { unsubscribe(); } catch {} };
  }, []);

  const loadTemplates = async () => {
    setIsLoading(true);
    try {
      const list = await base44.entities.NotificationTemplate.list();
      const map = {};
      (list || []).forEach(r => { if (r?.event_name) map[r.event_name] = r; });
      setRecords(map);
    } catch (e) {
      console.error('Error loading notification templates:', e);
    } finally {
      setIsLoading(false);
    }
  };

  const handleCreateTemplate = async () => {
    const key = newEventName.trim().toLowerCase().replace(/\s+/g, '_');
    if (!key || !newLabel.trim()) return;
    if (records[key]) { alert(`A template for "${key}" already exists.`); return; }
    setIsCreating(true);
    try {
      const created = await base44.entities.NotificationTemplate.create({
        event_name: key,
        label: newLabel.trim(),
        message_template: '',
        enabled: true,
        in_app_enabled: true,
        recipients: [],
        trigger_conditions: [],
      });
      setRecords((prev) => ({ ...prev, [key]: created }));
      applyTemplateUpdate(created);
      setShowAddDialog(false);
      setNewEventName('');
      setNewLabel('');
    } catch (e) {
      alert('Failed to create template: ' + (e?.message || e));
    } finally {
      setIsCreating(false);
    }
  };

  if (isLoading) {
    return <div className="flex items-center gap-2 p-6 text-slate-500"><Loader2 className="w-4 h-4 animate-spin" />Loading notification rules...</div>;
  }

  return (
    <>
      <div className="flex items-center justify-between mb-4">
        <div />
        <Button size="sm" variant="outline" onClick={() => setShowAddDialog(true)} className="gap-1.5">
          <Plus className="w-4 h-4" /> Add New Template
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* LEFT: Message Formats */}
        <div>
          <div className="mb-3">
            <h3 className="font-semibold text-slate-900">Message Formats</h3>
            <p className="text-xs text-slate-500 mt-0.5">Edit the template and channels for each notification type.</p>
          </div>
          <NotificationFormatPanel records={records} setRecords={setRecords} currentUser={currentUser} />
        </div>

        {/* RIGHT: Rules (When to Send) */}
        <div>
          <div className="mb-3">
            <h3 className="font-semibold text-slate-900">Trigger Rules</h3>
            <p className="text-xs text-slate-500 mt-0.5">Control who receives each notification and set optional conditions.</p>
          </div>
          <NotificationRulesPanel records={records} setRecords={setRecords} />
        </div>
      </div>

      <Dialog open={showAddDialog} onOpenChange={(open) => { if (!open) { setShowAddDialog(false); setNewEventName(''); setNewLabel(''); } }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Add New Notification Template</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label className="text-xs text-slate-600 mb-1 block">Event Key (internal identifier)</Label>
              <Input
                value={newEventName}
                onChange={(e) => setNewEventName(e.target.value)}
                placeholder="e.g. admin_broadcast"
                className="text-sm"
              />
              <p className="text-xs text-slate-400 mt-1">Lowercase, underscores only. Must be unique.</p>
            </div>
            <div>
              <Label className="text-xs text-slate-600 mb-1 block">Display Label</Label>
              <Input
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder="e.g. Admin Broadcast"
                className="text-sm"
              />
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button size="sm" variant="outline" onClick={() => setShowAddDialog(false)}>Cancel</Button>
            <Button size="sm" onClick={handleCreateTemplate} disabled={isCreating || !newEventName.trim() || !newLabel.trim()} className="gap-1">
              {isCreating ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}