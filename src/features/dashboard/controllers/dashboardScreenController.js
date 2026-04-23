import { useDashboardViewModel } from '@/features/dashboard/services/dashboardViewModel';

export function dashboardScreenController(props) {
  return useDashboardViewModel(props);
}