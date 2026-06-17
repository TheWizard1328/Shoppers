import DashboardView from '@/components/dashboard/DashboardView';

function DashboardLoadingScreen({ isFiltersReady }) {
  return (
    <div className="h-screen flex items-center justify-center">
      <div className="text-center">
        <div className="animate-spin w-8 h-8 border-4 border-emerald-600 border-t-transparent rounded-full mx-auto mb-4"></div>
        <p className="text-slate-600">
          {!isFiltersReady ? 'Initializing filters...' : 'Loading dashboard data...'}
        </p>
      </div>
    </div>
  );
}

export default function DashboardScreen(props) {
  if (props.isLoadingUser || !props.isFiltersReady || (!props.isDataLoaded && !props.userSettingsLoaded)) {
    return <DashboardLoadingScreen isFiltersReady={props.isFiltersReady} />;
  }

  return <DashboardView {...props} />;
}