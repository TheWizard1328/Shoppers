import { useDashboardViewModel } from '@/features/dashboard/services/dashboardViewModel';

export function useDashboardScreenController(props) {
  return useDashboardViewModel(props);
}