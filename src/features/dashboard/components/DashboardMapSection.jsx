import MapSection from '@/components/dashboard/MapSection';
import CompletedRouteControls from '@/components/dashboard/CompletedRouteControls';

export default function DashboardMapSection(props) {
  return (
    <>
      <MapSection {...props} />
      <CompletedRouteControls {...props} />
    </>
  );
}