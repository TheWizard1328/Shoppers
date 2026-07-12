import React, { useState, useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { applyTemplateUpdate } from '@/components/utils/notificationRules';
import NotificationFormatPanel from './NotificationFormatPanel';
import NotificationRulesPanel from './NotificationRulesPanel';

export default function MessageRulesManager() {
  const [records, setRecords] = useState({});
  const [isLoading, setIsLoading] = useState(true);
  const [currentUser, setCurrentUser] = useState(null);

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

  if (isLoading) {
    return <div className="flex items-center gap-2 p-6 text-slate-500"><Loader2 className="w-4 h-4 animate-spin" />Loading notification rules...</div>;
  }

  return (
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
  );
}