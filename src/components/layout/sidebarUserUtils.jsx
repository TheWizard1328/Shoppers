import { userHasRole } from '@/components/utils/userRoles';

export const canShowExportRoute = (currentUser) => {
  if (!currentUser) return false;
  return userHasRole(currentUser, 'dispatcher') || userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'driver');
};

export const getUserAvatarGradient = (currentUser) => {
  if (userHasRole(currentUser, 'admin')) return 'linear-gradient(135deg, #3b82f6, #2563eb)';
  if (userHasRole(currentUser, 'dispatcher')) return 'linear-gradient(135deg, #ef4444, #dc2626)';
  if (userHasRole(currentUser, 'driver')) return 'linear-gradient(135deg, #10b981, #059669)';
  return 'linear-gradient(135deg, #9ca3af, #6b7280)';
};