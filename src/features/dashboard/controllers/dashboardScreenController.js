import { createDashboardViewModel } from '@/features/dashboard/services/dashboardViewModel';

export function dashboardScreenController(props) {
  return createDashboardViewModel(props);
}