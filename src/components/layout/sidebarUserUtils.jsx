import { userHasRole } from '@/components/utils/userRoles';

export const canShowExportRoute = (currentUser) => {
  if (!currentUser) return false;
  return userHasRole(currentUser, 'dispatcher') || userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'driver');
};

export const getUserAvatarGradient = (currentUser) => {
  if (userHasRole(currentUser, 'admin')) return 'bg-gradient-to-br from-blue-500 to-blue-600';
  if (userHasRole(currentUser, 'dispatcher')) return 'bg-gradient-to-br from-red-500 to-red-600';
  if (userHasRole(currentUser, 'driver')) return 'bg-gradient-to-br from-emerald-500 to-emerald-600';
  return 'bg-gradient-to-br from-gray-400 to-gray-500';
};