import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { X, LogOut, Trash2, Loader2 } from 'lucide-react';
import { PRESET_LABELS, PRESET_BADGE_STYLES } from './groupHelpers';

/**
 * GroupMembersSheet — shows all group members with the ability to leave the group
 * (any member) or delete the group (creator only). Opens as a right-side sheet.
 *
 * Props:
 *  - group — ConversationGroup record
 *  - currentUser
 *  - appUsers — full AppUser records (for name resolution)
 *  - onLeave(groupId) — parent removes the group from local state
 *  - onDelete(groupId)
 *  - onClose()
 */
export default function GroupMembersSheet({ group, currentUser, appUsers = [], onLeave, onDelete, onClose }) {
  const [isWorking, setIsWorking] = useState(false);

  const isCreator = group?.created_by === currentUser?.id;
  const memberIds = Array.isArray(group?.member_ids) ? group.member_ids : [];
  const isPreset = group?.preset_type && group.preset_type !== 'custom';

  const getMemberName = (uid) => {
    const au = (appUsers || []).find((u) => u.user_id === uid);
    return au?.user_name || au?.full_name || 'Unknown User';
  };

  const getMemberRoles = (uid) => {
    const au = (appUsers || []).find((u) => u.user_id === uid);
    return Array.isArray(au?.app_roles) ? au.app_roles : [];
  };

  const handleLeave = async () => {
    if (!group?.id || isWorking) return;
    if (!window.confirm('Leave this group? You will no longer receive messages from it.')) return;
    setIsWorking(true);
    try {
      if (isPreset) {
        // Preset groups recompute membership live; we can't remove a role-matching user
        // permanently, but we can delete the group record if the creator leaves, OR
        // for non-creators we record a lightweight "excluded" member by mutating the
        // stored member_ids to exclude. For simplicity presets: creator leaving deletes
        // the group; non-creator leaving is a no-op on the group (membership recomputes
        // live) so we just remove it from the local list for this session.
        if (isCreator) {
          await base44.entities.ConversationGroup.delete(group.id);
        }
      } else {
        const next = memberIds.filter((id) => id !== currentUser.id);
        await base44.entities.ConversationGroup.update(group.id, { member_ids: next });
      }
      onLeave?.(group.id);
    } catch (err) {
      console.error('Error leaving group:', err);
      alert('Failed to leave the group. Please try again.');
    } finally {
      setIsWorking(false);
    }
  };

  const handleDelete = async () => {
    if (!group?.id || isWorking) return;
    if (!window.confirm('Delete this group for everyone? All messages will remain but the group will be removed.')) return;
    setIsWorking(true);
    try {
      await base44.entities.ConversationGroup.delete(group.id);
      onDelete?.(group.id);
    } catch (err) {
      console.error('Error deleting group:', err);
      alert('Failed to delete the group. Please try again.');
    } finally {
      setIsWorking(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[10000] bg-black/50 flex items-center justify-end p-0">
      <div className="h-full w-full max-w-sm flex flex-col bg-surface shadow-2xl">
        {/* Header */}
        <div className="p-4 flex items-center justify-between gap-3" style={{ borderBottom: '1px solid var(--border-slate-200)' }}>
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-body truncate">{group?.name || 'Group'}</h3>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-xs text-soft">{memberIds.length} member{memberIds.length !== 1 ? 's' : ''}</span>
              {group?.preset_type && group.preset_type !== 'custom' && (
                <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${PRESET_BADGE_STYLES[group.preset_type] || ''}`}>
                  {PRESET_LABELS[group.preset_type]}
                </span>
              )}
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} disabled={isWorking}>
            <X className="w-5 h-5 text-body-2" />
          </Button>
        </div>

        {/* Members list */}
        <div className="flex-1 overflow-y-auto">
          {memberIds.map((uid) => {
            const isYou = uid === currentUser?.id;
            const isMemberCreator = uid === group?.created_by;
            const roles = getMemberRoles(uid);
            return (
              <div
                key={uid}
                className="p-3 flex items-center gap-3"
                style={{ borderBottom: '1px solid var(--border-slate-200)' }}
              >
                <div className="w-9 h-9 rounded-full bg-emerald-500 flex items-center justify-center text-white font-semibold text-sm flex-shrink-0">
                  {getMemberName(uid)[0].toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate text-body">
                    {getMemberName(uid)}{isYou && ' (You)'}
                  </p>
                  <div className="flex gap-1 flex-wrap mt-0.5">
                    {isMemberCreator && (
                      <span className="text-xs px-1.5 py-0.5 rounded font-medium bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">Creator</span>
                    )}
                    {roles.map((r) => (
                      <span key={r} className="text-xs px-1.5 py-0.5 rounded capitalize" style={{ background: 'var(--bg-slate-100)', color: 'var(--text-slate-500)' }}>
                        {r}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer actions */}
        <div className="p-4 space-y-2" style={{ borderTop: '1px solid var(--border-slate-200)' }}>
          {!isCreator && (
            <Button
              variant="outline"
              className="w-full text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
              onClick={handleLeave}
              disabled={isWorking}
            >
              {isWorking ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <LogOut className="w-4 h-4 mr-2" />}
              Leave Group
            </Button>
          )}
          {isCreator && (
            <Button
              variant="outline"
              className="w-full text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
              onClick={handleDelete}
              disabled={isWorking}
            >
              {isWorking ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Trash2 className="w-4 h-4 mr-2" />}
              Delete Group
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}