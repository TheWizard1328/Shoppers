import '@/components/utils/storageQuotaGuard'
import '@/components/utils/remoteLoggerInit'
import './App.css'
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClientInstance } from '@/lib/query-client'
import NavigationTracker from '@/lib/NavigationTracker'
import { pagesConfig } from './pages.config'
import { BrowserRouter as Router, Route, Routes } from 'react-router-dom';
import PageNotFound from './lib/PageNotFound';
import { AuthProvider, useAuth } from '@/lib/AuthContext';
import { MobileNavigationProvider } from '@/components/navigation/MobileNavigationProvider';
import MobileTabScrollManager from '@/components/navigation/MobileTabScrollManager';
import UserNotRegisteredError from '@/components/UserNotRegisteredError';
import { DeviceProvider } from '@/components/utils/DeviceContext';
import SquareSyncAudit from '@/pages/SquareSyncAudit';
import StatHolidays from '@/pages/StatHolidays';
import Companies from '@/pages/Companies';
import DriverScheduleCalendar from '@/pages/DriverScheduleCalendar';
import PatientLogin from '@/pages/PatientLogin';
import PatientPortal from '@/pages/PatientPortal';
import Login from '@/pages/Login';
import Register from '@/pages/Register';
import ForgotPassword from '@/pages/ForgotPassword';
import ResetPassword from '@/pages/ResetPassword';
import ProtectedRoute from '@/components/ProtectedRoute';
import { Navigate } from 'react-router-dom';

const cleanupLocalStorageQuota = () => {
  try {
    const protectedKeys = new Set(['base44_server_url', 'base44_data_env', 'rxdeliver_device_identifier']);
    const isProtected = (key) => protectedKeys.has(key) || key.startsWith('base44_');
    const getSize = (key) => {
      const value = localStorage.getItem(key) || '';
      return key.length + value.length;
    };
    const keys = Object.keys(localStorage);
    let totalSize = keys.reduce((sum, key) => sum + getSize(key), 0);
    if (totalSize < 4000000) return;

    const removableKeys = keys
      .filter((key) => !isProtected(key))
      .map((key) => ({ key, size: getSize(key) }))
      .sort((a, b) => b.size - a.size);

    for (const entry of removableKeys) {
      localStorage.removeItem(entry.key);
      totalSize -= entry.size;
      if (totalSize < 3000000) break;
    }
  } catch (error) {
    console.warn('Storage cleanup skipped:', error?.message || error);
  }
};

cleanupLocalStorageQuota();

const { Pages, Layout, mainPage } = pagesConfig;
const mainPageKey = mainPage ?? Object.keys(Pages)[0];
const MainPage = mainPageKey ? Pages[mainPageKey] : <></>;

const LayoutWrapper = ({ children, currentPageName }) => Layout ?
  <Layout currentPageName={currentPageName}>{children}</Layout>
  : <>{children}</>;

const AuthenticatedApp = () => {
  const { isLoadingAuth, isLoadingPublicSettings, authError } = useAuth();

  // Show loading spinner while checking app public settings or auth
  if (isLoadingPublicSettings || isLoadingAuth) {
    return (
      <div className="fixed inset-0 flex items-center justify-center">
        <div className="w-8 h-8 border-4 border-slate-200 border-t-slate-800 rounded-full animate-spin"></div>
      </div>
    );
  }

  if (authError?.type === 'user_not_registered') {
    return <UserNotRegisteredError />;
  }

  return (
    <Routes>
      {/* Patient Portal — public routes (no platform auth required) */}
      <Route path="/patient-login" element={<PatientLogin />} />
      <Route path="/patient-portal" element={<PatientPortal />} />

      {/* Public auth routes */}
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />

      {/* All app routes protected — redirect unauthenticated users to /login */}
      <Route element={<ProtectedRoute unauthenticatedElement={<Navigate to="/login" replace />} />}>
        <Route path="/" element={
          <LayoutWrapper currentPageName={mainPageKey}>
            <MainPage />
          </LayoutWrapper>
        } />
        {Object.entries(Pages).map(([path, Page]) => (
          <Route
            key={path}
            path={`/${path}`}
            element={
              <LayoutWrapper currentPageName={path}>
                <Page />
              </LayoutWrapper>
            }
          />
        ))}
        <Route
          path="/Companies"
          element={
            <LayoutWrapper currentPageName="Companies">
              <Companies />
            </LayoutWrapper>
          }
        />
        <Route
          path="/SquareSyncAudit"
          element={
            <LayoutWrapper currentPageName="SquareSyncAudit">
              <SquareSyncAudit />
            </LayoutWrapper>
          }
        />
        <Route
          path="/DriverScheduleCalendar"
          element={
            <LayoutWrapper currentPageName="DriverScheduleCalendar">
              <DriverScheduleCalendar />
            </LayoutWrapper>
          }
        />
        <Route
          path="/StatHolidays"
          element={
            <LayoutWrapper currentPageName="StatHolidays">
              <StatHolidays />
            </LayoutWrapper>
          }
        />
      </Route>

      <Route path="*" element={<PageNotFound />} />
    </Routes>
  );
};


function App() {

  return (
    <AuthProvider>
      <QueryClientProvider client={queryClientInstance}>
        <DeviceProvider>
          <Router>
            <MobileNavigationProvider>
              <NavigationTracker />
              <MobileTabScrollManager />
              <AuthenticatedApp />
            </MobileNavigationProvider>
          </Router>
        </DeviceProvider>
      </QueryClientProvider>
    </AuthProvider>
  )
}

export default App