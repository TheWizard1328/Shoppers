import StatsPanel from '@/components/dashboard/StatsPanel';

export default function DashboardStatsPanel(props) {
  // Compute live padding debug values from the already-available getMapPadding fn
  const mapPaddingDebugValues = props.getMapPadding ? props.getMapPadding(false)?._debug : null;
  return <StatsPanel {...props} mapPaddingDebugValues={mapPaddingDebugValues} />;
}