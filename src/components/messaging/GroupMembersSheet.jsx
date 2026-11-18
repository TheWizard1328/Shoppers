import React, { useState, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { X, LogOut, Trash2, Loader2, UserPlus, Search, CheckCircle2, ChevronLeft } from 'lucide-react';
import { PRESET_LABELS, PRESET_BADGE_STYLES, resolveGroupMemberIds, resolveGroupExtraMemberIds } from './groupHelpers';

/**
 * GroupMembersSheet — shows all group members with the ability to leave the group
 * (any member), delete the group (creator only), and ADD MEMBERS (owner request
 * Nov 18 2026: the Add Members button sits to the right of Leave Group).
 *
 * Membership semantics:
 *  - custom group  → stored member_ids snapshot; adding appends to it.
 *  - preset group  → membership is resolved LIVE from AppUser.app_roles, so a
 *    hand-picked person is stored in extra_member_ids and unioned in at
 *    read/send time (resolveGroupMemberIds). Only those extras can be removed.
 *
 * Props:
 *  - group — ConversationGroup record
 *  - currentUser
 *  - appUsers — full AppUser records (for name resolution + the add picker)
 *  - onLeave(groupId) — parent removes the group from local state
 *  - onDelete(groupId)
 *  - onMembersChanged(nextGroup) — parent refreshes its copy of the group
 *  - onClose()
 */
export default function GroupMembersSheet({ group, currentUser, appUsers = [], onLeave, onDelete, onMembersChanged, onClose }) {
  const [isWorking, setIsWorking] = useState(false);
  const [localGroup, setLocalGroup] = useState(group || null);
  const [isAdding, setIsAdding] = useState(false);
  const [selectedIds, setSelectedIds] = useState([]);
  const [search, setSearch] = useState('');

  const isCreator = localGroup?.created_by === currentUser?.id;
  const isPreset = !!(localGroup?.preset_type && localGroup.preset_type !== 'custom');
  const extraMemberIds = useMemo(() => resolveGroupExtraMemberIds(localGroup), [localGroup]);
  // Resolved (not the stored snapshot) so what the sheet lists is exactly who
  // receives the group's messages, including hand-added members.
  const memberIds = useMemo(() => resolveGroupMemberIds(localGroup, appUsers), [localGroup, appUsers]);

  const getMemberName = (uid) => {
    const au = (appUsers || []).find((u) => u.user_id === uid);
    return au?.user_name || au?.full_name || 'Unknown User';
  };

  const getMemberRoles = (uid) => {
    const au = (appUsers || []).find((u) => u.user_id === uid);
    return Array.isArray(au?.app_roles) ? au.app_roles : [];
  };

  // People who can be added: active accounts not already in the group.
  const addableUsers = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (appUsers || [])
      .filter((au) => au && au.status === 'active' && au.user_id && !memberIds.includes(au.user_id))
      .filter((au) => {
        if (!q) return true;
        const name = String(au.user_name || au.full_name || '').toLowerCase();
        return name.includes(q);
      })
      .sort((a, b) => String(a.user_name || a.full_name || '').localeCompare(String(b.user_name || b.full_name || '')));
  }, [appUsers, memberIds, search]);

  const toggleSelected = (uid) => {
    setSelectedIds((prev) => (prev.includes(uid) ? prev.filter((id) => id !== uid) : [...prev, uid]));
  };

  const applyGroupUpdate = async (patch) => {
    const updated = await base44.entities.ConversationGroup.update(localGroup.id, patch);
    const next = {
      ...localGroup,
      ...patch,
      ...(updated && typeof updated === 'object' ? updated : {}),
    };
    setLocalGroup(next);
    onMembersChanged?.(next);
    return next;
  };

  const handleAddMembers = async () => {
    if (!localGroup?.id || isWorking || selectedIds.length === 0) return;
    setIsWorking(true);
    try {
      if (isPreset) {
        // Role presets can't be edited person-by-person: store the hand-picked
        // people as extras and let resolveGroupMemberIds union them in.
        const nextExtras = Array.from(new Set([...extraMemberIds, ...selectedIds]));
        await applyGroupUpdate({ extra_member_ids: nextExtras });
      } else {
        const existing = Array.isArray(localGroup.member_ids) ? localGroup.member_ids : [];
        await applyGroupUpdate({ member_ids: Array.from(new Set([...existing, ...selectedIds])) });
      }
      setSelectedIds([]);
      setSearch('');
      setIsAdding(false);
    } catch (err) {
      console.error('Error adding group members:', err);
      alert('Failed to add the selected members. Please try again.');
    } finally {
      setIsWorking(false);
    }
  };

  // A member can be removed when they are not you, not the creator, and their
  // membership is not implied by the preset's role rule.
  const canRemoveMember = (uid) => {
    if (!uid || uid === currentUser?.id) return false;
    if (uid === localGroup?.created_by) return false;
    if (isPreset) return extraMemberIds.includes(uid);
    return true;
  };

  const handleRemoveMember = async (uid) => {
    if (!localGroup?.id || isWorking || !canRemoveMember(uid)) return;
    if (!window.confirm(`Remove ${getMemberName(uid)} from this group?`)) return;
    setIsWorking(true);
    try {
      if (isPreset) {
        await applyGroupUpdate({ extra_member_ids: extraMemberIds.filter((id) => id !== uid) });
      } else {
        const existing = Array.isArray(localGroup.member_ids) ? localGroup.member_ids : [];
        await applyGroupUpdate({ member_ids: existing.filter((id) => id !== uid) });
      }
    } catch (err) {
      console.error('Error removing group member:', err);
      alert('Failed to remove that member. Please try again.');
    } finally {
      setIsWorking(false);
    }
  };

  const handleLeave = async () => {
    if (!localGroup?.id || isWorking) return;
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
          await base44.entities.ConversationGroup.delete(localGroup.id);
        }
      } else {
        const next = memberIds.filter((id) => id !== currentUser.id);
        await base44.entities.ConversationGroup.update(localGroup.id, { member_ids: next });
      }
      onLeave?.(localGroup.id);
    } catch (err) {
      console.error('Error leaving group:', err);
      alert('Failed to leave the group. Please try again.');
    } finally {
      setIsWorking(false);
    }
  };

  const handleDelete = async () => {
    if (!localGroup?.id || isWorking) return;
    if (!window.confirm('Delete this group for everyone? All messages will remain but the group will be removed.')) return;
    setIsWorking(true);
    try {
      await base44.entities.ConversationGroup.delete(localGroup.id);
      onDelete?.(localGroup.id);
    } catch (err) {
      console.error('Error deleting group:', err);
      alert('Failed to delete the group. Please try again.');
    } finally {
      setIsWorking(false);
    }
  };

  const closeAddMode = () => {
    setIsAdding(false);
    setSelectedIds([]);
    setSearch('');
  };

  return (
    <div className="fixed inset-0 z-[50010] bg-black/50 flex items-center justify-end p-0">
      <div className="h-full w-full max-w-sm flex flex-col bg-surface shadow-2xl">
        {/* Header */}
        <div className="p-4 flex items-center justify-between gap-3" style={{ borderBottom: '1px solid var(--border-slate-200)' }}>
          <div className="flex items-center gap-2 min-w-0">
            {isAdding && (
              <Button variant="ghost" size="icon" onClick={closeAddMode} disabled={isWorking} className="flex-shrink-0">
                <ChevronLeft className="w-5 h-5 text-body-2" />
              </Button>
            )}
            <div className="min-w-0">
              <h3 className="text-base font-semibold text-body truncate">{isAdding ? 'Add Members' : (localGroup?.name || 'Group')}</h3>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-xs text-soft">
                  {isAdding
                    ? `${addableUsers.length} available`
                    : `${memberIds.length} member${memberIds.length !== 1 ? 's' : ''}`}
                </span>
                {!isAdding && localGroup?.preset_type && localGroup.preset_type !== 'custom' && (
                  <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${PRESET_BADGE_STYLES[localGroup.preset_type] || ''}`}>
                    {PRESET_LABELS[localGroup.preset_type]}
                  </span>
                )}
              </div>
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={isAdding ? closeAddMode : onClose} disabled={isWorking} className="flex-shrink-0">
            <X className="w-5 h-5 text-body-2" />
          </Button>
        </div>

        {/* Add-member search */}
        {isAdding && (
          <div className="p-3" style={{ borderBottom: '1px solid var(--border-slate-200)' }}>
            <div className="relative">
              <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-soft" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search people"
                className="pl-8 h-9"
              />
            </div>
          </div>
        )}

        {/* Members list / add picker */}
        <div className="flex-1 overflow-y-auto">
          {isAdding ? (
            addableUsers.length === 0 ? (
              <p className="p-4 text-sm text-soft text-center">
                {search.trim() ? 'Nobody matches that search.' : 'Everyone active is already in this group.'}
              </p>
            ) : (
              addableUsers.map((au) => {
                const uid = au.user_id;
                const name = au.user_name || au.full_name || 'Unknown User';
                const roles = Array.isArray(au.app_roles) ? au.app_roles : [];
                const selected = selectedIds.includes(uid);
                return (
                  <button
                    key={uid}
                    type="button"
                    onClick={() => toggleSelected(uid)}
                    disabled={isWorking}
                    className={`w-full text-left p-3 flex items-center gap-3 transition-colors ${selected ? 'bg-emerald-50 dark:bg-emerald-900/20' : 'hover:bg-slate-50 dark:hover:bg-slate-800/50'}`}
                    style={{ borderBottom: '1px solid var(--border-slate-200)' }}
                  >
                    <div className="w-9 h-9 rounded-full bg-emerald-500 flex items-center justify-center text-white font-semibold text-sm flex-shrink-0">
                      {name[0]?.toUpperCase() || '?'}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate text-body">{name}</p>
                      <div className="flex gap-1 flex-wrap mt-0.5">
                        {roles.map((r) => (
                          <span key={r} className="text-xs px-1.5 py-0.5 rounded capitalize" style={{ background: 'var(--bg-slate-100)', color: 'var(--text-slate-500)' }}>
                            {r}
                          </span>
                        ))}
                      </div>
                    </div>
                    <CheckCircle2 className={`w-5 h-5 flex-shrink-0 ${selected ? 'text-emerald-600' : 'text-slate-300 dark:text-slate-600'}`} />
                  </button>
                );
              })
            )
          ) : (
            memberIds.map((uid) => {
              const isYou = uid === currentUser?.id;
              const isMemberCreator = uid === localGroup?.created_by;
              const roles = getMemberRoles(uid);
              const removable = canRemoveMember(uid);
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
                  {removable && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="flex-shrink-0 text-soft hover:text-red-600"
                      onClick={() => handleRemoveMember(uid)}
                      disabled={isWorking}
                      title={`Remove ${getMemberName(uid)}`}
                    >
                      <X className="w-4 h-4" />
                    </Button>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Footer actions */}
        <div className="p-4" style={{ borderTop: '1px solid var(--border-slate-200)' }}>
          {isAdding ? (
            <Button
              className="w-full bg-emerald-600 hover:bg-emerald-700"
              onClick={handleAddMembers}
              disabled={isWorking || selectedIds.length === 0}
            >
              {isWorking ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <UserPlus className="w-4 h-4 mr-2" />}
              {selectedIds.length > 0 ? `Add ${selectedIds.length} member${selectedIds.length !== 1 ? 's' : ''}` : 'Add Members'}
            </Button>
          ) : (
            <div className="flex items-center gap-2">
              {/* OWNER REQUEST (Nov 18 2026): Add Members sits to the RIGHT of
                  Leave Group / Delete Group. */}
              {!isCreator ? (
                <Button
                  variant="outline"
                  className="flex-1 text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
                  onClick={handleLeave}
                  disabled={isWorking}
                >
                  {isWorking ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <LogOut className="w-4 h-4 mr-2" />}
                  Leave Group
                </Button>
              ) : (
                <Button
                  variant="outline"
                  className="flex-1 text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
                  onClick={handleDelete}
                  disabled={isWorking}
                >
                  {isWorking ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Trash2 className="w-4 h-4 mr-2" />}
                  Delete Group
                </Button>
              )}
              <Button
                className="flex-1 bg-emerald-600 hover:bg-emerald-700"
                onClick={() => { setSelectedIds([]); setSearch(''); setIsAdding(true); }}
                disabled={isWorking}
              >
                <UserPlus className="w-4 h-4 mr-2" />
                Add Members
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
