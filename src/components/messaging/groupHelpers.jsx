import { Users, Truck, Headphones, ShieldCheck } from 'lucide-react';

// Preset group definitions — membership is resolved live from AppUser.app_roles.
export const PRESET_TYPES = [
  { value: 'custom', label: 'Custom', description: 'Pick specific members', icon: Users },
  { value: 'all_drivers', label: 'All Drivers', description: 'Everyone with the driver role', icon: Truck },
  { value: 'all_dispatchers', label: 'All Dispatchers', description: 'Everyone with the dispatcher role', icon: Headphones },
  { value: 'all_admins', label: 'All Admins', description: 'Administrators only', icon: ShieldCheck },
];

export const PRESET_LABELS = PRESET_TYPES.reduce((acc, p) => {
  acc[p.value] = p.label;
  return acc;
}, {});

export const PRESET_BADGE_STYLES = {
  custom: 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200',
  all_drivers: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  all_dispatchers: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
  all_admins: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
};

/**
 * Resolve member_ids for a preset group from the live AppUser list.
 * @param {Array} appUsers — full AppUser records (must have app_roles + status)
 * @param {string} presetType — one of all_drivers | all_dispatchers | all_admins
 * @returns {string[]} user_ids matching the role + active status
 */
export const resolvePresetMemberIds = (appUsers = [], presetType) => {
  if (!presetType || presetType === 'custom') return [];
  const roleMap = {
    all_drivers: 'driver',
    all_dispatchers: 'dispatcher',
    all_admins: 'admin',
  };
  const role = roleMap[presetType];
  if (!role) return [];
  return (appUsers || [])
    .filter((au) => au && au.status === 'active' && Array.isArray(au.app_roles) && au.app_roles.includes(role))
    .map((au) => au.user_id)
    .filter(Boolean);
};

/**
 * Resolve the effective member_ids for a group, recomputing live for presets.
 * @param {Object} group — ConversationGroup record
 * @param {Array} appUsers — full AppUser records
 * @returns {string[]}
 */
export const resolveGroupMemberIds = (group, appUsers = []) => {
  if (!group) return [];
  if (group.preset_type && group.preset_type !== 'custom') {
    const roleIds = resolvePresetMemberIds(appUsers, group.preset_type);
    // Always include the group creator so they can see (and receive replies in)
    // their own preset group even when their role doesn't match the preset.
    // NewGroupDialog already adds the creator to the stored member_ids snapshot;
    // honor that here by unioning created_by with the live role resolution.
    const creatorId = group.created_by;
    if (creatorId && !roleIds.includes(creatorId)) return [creatorId, ...roleIds];
    return roleIds;
  }
  return Array.isArray(group.member_ids) ? [...group.member_ids] : [];
};

/**
 * Build a short avatar label from a group (first 2-3 member initials stacked).
 * @param {Object} group
 * @param {Array} appUsers
 * @param {string} currentUserId
 * @returns {string[]} up to 3 initials
 */
export const getGroupAvatarInitials = (group, appUsers = [], currentUserId) => {
  const memberIds = resolveGroupMemberIds(group, appUsers);
  const others = memberIds.filter((id) => id !== currentUserId).slice(0, 3);
  if (others.length === 0 && memberIds.length > 0) {
    // creator-only group or all-me group
    return memberIds.slice(0, 1).map((id) => {
      const au = (appUsers || []).find((u) => u.user_id === id);
      return (au?.user_name || au?.full_name || '?')[0].toUpperCase();
    });
  }
  return others.map((id) => {
    const au = (appUsers || []).find((u) => u.user_id === id);
    return (au?.user_name || au?.full_name || '?')[0].toUpperCase();
  });
};