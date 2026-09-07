import React, { useState, useMemo, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { X, Users, Truck, Headphones, ShieldCheck, Search, Check, Loader2 } from 'lucide-react';
import { PRESET_TYPES } from './groupHelpers';

/**
 * NewGroupDialog — create a group thread.
 * Preset (role-based) groups resolve membership live at read/send time.
 * Custom groups store a member_ids snapshot.
 *
 * Props:
 *  - currentUser
 *  - appUsers — full AppUser records (active users)
 *  - onCreated(groupRecord) — called with the created ConversationGroup; parent opens the chat
 *  - onClose()
 */
export default function NewGroupDialog({ currentUser, appUsers = [], onCreated, onClose }) {
  const [name, setName] = useState('');
  const [presetType, setPresetType] = useState('custom');
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [search, setSearch] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState('');

  const presetPreviewCounts = useMemo(() => {
    const counts = {};
    PRESET_TYPES.forEach((p) => {
      if (p.value === 'custom') {
        counts.custom = selectedIds.size;
      } else {
        const role = { all_drivers: 'driver', all_dispatchers: 'dispatcher', all_admins: 'admin' }[p.value];
        counts[p.value] = (appUsers || []).filter(
          (au) => au && au.status === 'active' && Array.isArray(au.app_roles) && au.app_roles.includes(role)
        ).length;
      }
    });
    return counts;
  }, [appUsers, selectedIds.size]);

  const eligibleUsers = useMemo(() => {
    return (appUsers || [])
      .filter((au) => au && au.status === 'active' && au.user_id && au.user_id !== currentUser?.id)
      .filter((au) => {
        const fullName = au.user_name || au.full_name || '';
        if (!search.trim()) return true;
        return fullName.toLowerCase().includes(search.toLowerCase());
      })
      .sort((a, b) => (a.user_name || '').localeCompare(b.user_name || ''));
  }, [appUsers, currentUser?.id, search]);

  const toggleUser = useCallback((userId) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }, []);

  const handleSubmit = async () => {
    if (isCreating) return;
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('Please enter a group name.');
      return;
    }
    if (presetType === 'custom' && selectedIds.size === 0) {
      setError('Please select at least one member.');
      return;
    }

    setIsCreating(true);
    setError('');
    try {
      // Resolve member_ids: presets store empty (recomputed live); custom stores the snapshot.
      const roleMap = { all_drivers: 'driver', all_dispatchers: 'dispatcher', all_admins: 'admin' };
      let memberIds;
      if (presetType === 'custom') {
        memberIds = Array.from(selectedIds);
      } else {
        const role = roleMap[presetType];
        memberIds = (appUsers || [])
          .filter((au) => au && au.status === 'active' && Array.isArray(au.app_roles) && au.app_roles.includes(role))
          .map((au) => au.user_id)
          .filter(Boolean);
      }

      // Ensure creator is always included.
      if (currentUser?.id && !memberIds.includes(currentUser.id)) {
        memberIds.push(currentUser.id);
      }

      const created = await base44.entities.ConversationGroup.create({
        name: trimmedName,
        member_ids: memberIds,
        preset_type: presetType,
        created_by: currentUser.id,
        created_by_name: currentUser.user_name || currentUser.full_name || 'Unknown',
      });

      onCreated?.(created);
    } catch (err) {
      console.error('Error creating group:', err);
      setError(err?.message || 'Failed to create group. Please try again.');
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[10000] bg-black/50 flex items-center justify-center p-4 overflow-y-auto">
      <div className="rounded-xl shadow-2xl w-full max-w-lg flex flex-col overflow-hidden bg-surface max-h-[90vh]">
        {/* Header */}
        <div className="p-4 flex items-center justify-between gap-3" style={{ borderBottom: '1px solid var(--border-slate-200)' }}>
          <h3 className="text-lg font-semibold text-body">New Group</h3>
          <Button variant="ghost" size="icon" onClick={onClose} disabled={isCreating}>
            <X className="w-5 h-5 text-body-2" />
          </Button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-5">
          {/* Group name */}
          <div className="space-y-2">
            <Label htmlFor="group-name" className="text-body-2">Group Name</Label>
            <Input
              id="group-name"
              placeholder="e.g. West End Dispatch, Weekend Drivers"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={60}
              disabled={isCreating}
            />
          </div>

          {/* Preset selector */}
          <div className="space-y-2">
            <Label className="text-body-2">Group Type</Label>
            <div className="grid grid-cols-2 gap-2">
              {PRESET_TYPES.map((p) => {
                const Icon = p.icon;
                const isActive = presetType === p.value;
                return (
                  <button
                    key={p.value}
                    type="button"
                    onClick={() => setPresetType(p.value)}
                    disabled={isCreating}
                    className="text-left rounded-xl border p-3 transition-all disabled:opacity-50"
                    style={{
                      borderColor: isActive ? '#10b981' : 'var(--border-slate-200)',
                      background: isActive ? 'rgba(16,185,129,0.08)' : 'var(--bg-slate-50)',
                    }}
                  >
                    <div className="flex items-center gap-2">
                      <Icon className="w-4 h-4" style={{ color: isActive ? '#10b981' : 'var(--text-slate-500)' }} />
                      <span className="font-medium text-sm text-body">{p.label}</span>
                    </div>
                    <p className="text-xs mt-1 text-soft">{p.description}</p>
                    <span className="text-xs font-semibold" style={{ color: isActive ? '#10b981' : 'var(--text-slate-500)' }}>
                      {presetPreviewCounts[p.value] || 0} {p.value === 'custom' ? 'selected' : 'members'}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Custom member picker */}
          {presetType === 'custom' && (
            <div className="space-y-2">
              <Label className="text-body-2">Members</Label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: 'var(--text-slate-400)' }} />
                <Input
                  placeholder="Search users..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-9"
                  disabled={isCreating}
                />
              </div>
              <div className="rounded-xl border max-h-64 overflow-y-auto" style={{ borderColor: 'var(--border-slate-200)', background: 'var(--bg-slate-50)' }}>
                {eligibleUsers.length === 0 && (
                  <p className="text-center py-6 text-sm text-soft">No users found.</p>
                )}
                {eligibleUsers.map((au) => {
                  const isSelected = selectedIds.has(au.user_id);
                  const roles = Array.isArray(au.app_roles) ? au.app_roles : [];
                  return (
                    <button
                      key={au.user_id}
                      type="button"
                      onClick={() => toggleUser(au.user_id)}
                      disabled={isCreating}
                      className="w-full flex items-center gap-3 p-2.5 text-left transition-colors"
                      style={{ borderBottom: '1px solid var(--border-slate-200)' }}
                      onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = 'var(--bg-white)'; }}
                      onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}
                    >
                      <div className="w-8 h-8 rounded-full bg-slate-400 flex items-center justify-center text-white font-semibold text-sm flex-shrink-0">
                        {(au.user_name || au.full_name || '?')[0].toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate text-body">{au.user_name || au.full_name}</p>
                        <div className="flex gap-1 flex-wrap">
                          {roles.map((r) => (
                            <span key={r} className="text-xs px-1.5 py-0.5 rounded capitalize" style={{ background: 'var(--bg-slate-100)', color: 'var(--text-slate-500)' }}>
                              {r}
                            </span>
                          ))}
                        </div>
                      </div>
                      {isSelected && (
                        <Check className="w-5 h-5 text-emerald-500 flex-shrink-0" />
                      )}
                    </button>
                  );
                })}
              </div>
              {selectedIds.size > 0 && (
                <p className="text-xs text-soft">{selectedIds.size} member{selectedIds.size !== 1 ? 's' : ''} selected</p>
              )}
            </div>
          )}

          {error && (
            <p className="text-sm text-red-500">{error}</p>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 flex items-center justify-end gap-2" style={{ borderTop: '1px solid var(--border-slate-200)' }}>
          <Button variant="ghost" onClick={onClose} disabled={isCreating}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={isCreating} className="bg-emerald-500 hover:bg-emerald-600">
            {isCreating ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Users className="w-4 h-4 mr-2" />}
            Create Group
          </Button>
        </div>
      </div>
    </div>
  );
}