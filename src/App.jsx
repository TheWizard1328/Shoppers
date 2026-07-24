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
import ProtectedRoute from '@/components/ProtectedRoute';
import { Navigate } from 'react-router-dom';
import { lazy, Suspense } from 'react';
import { lazy as lazyReact, Suspense as SuspenseReact } from 'react';

// Lazy-load pages that are imported directly (not in pages.config.js)
const SquareSyncAudit = lazyReact(() => import('@/pages/SquareSyncAudit'));
const StatHolidays = lazyReact(() => import('@/pages/StatHolidays'));
const SecureDocViewer = lazyReact(() => import('@/pages/SecureDocViewer'));
const Companies = lazyReact(() => import('@/pages/Companies'));
const DriverScheduleCalendar = lazyReact(() => import('@/pages/DriverScheduleCalendar'));
const PatientLogin = lazyReact(() => import('@/pages/PatientLogin'));
const PatientPortal = lazyReact(() => import('@/pages/PatientPortal'));
const Login = lazyReact(() => import('@/pages/Login'));
const Register = lazyReact(() => import('@/pages/Register'));
const ForgotPassword = lazyReact(() => import('@/pages/ForgotPassword'));
const ResetPassword = lazyReact(() => import('@/pages/ResetPassword'));

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

// Loading fallback for lazy-loaded pages
const PageLoader = () => (
  <div className="fixed inset-0 flex items-center justify-center">
    <div className="w-8 h-8 border-4 border-slate-200 border-t-slate-800 rounded-full animate-spin"></div>
  </div>
);

const LazyPageWrapper = ({ children }) => (
  <SuspenseReact fallback={<PageLoader />}>
    {children}
  </SuspenseReact>
);

const AuthenticatedApp = () => {
  const { isLoadingAuth, isLoadingPublicSettings, authError } = useAuth();

  // Show loading spinner while checking app public settings or auth
  if (isLoadingPublicSettings || isLoadingAuth) {
    return <PageLoader />;
  }

  if (authError?.type === 'user_not_registered') {
    return <UserNotRegisteredError />;
  }

  return (
    <Routes>
      {/* Patient Portal — public routes (no platform auth required) */}
      <Route path="/patient-login" element={<LazyPageWrapper><PatientLogin /></LazyPageWrapper>} />
      <Route path="/patient-portal" element={<LazyPageWrapper><PatientPortal /></LazyPageWrapper>} />

      {/* Public auth routes */}
      <Route path="/login" element={<LazyPageWrapper><Login /></LazyPageWrapper>} />
      <Route path="/register" element={<LazyPageWrapper><Register /></LazyPageWrapper>} />
      <Route path="/forgot-password" element={<LazyPageWrapper><ForgotPassword /></LazyPageWrapper>} />
      <Route path="/reset-password" element={<LazyPageWrapper><ResetPassword /></LazyPageWrapper>} />

      {/* All app routes protected — redirect unauthenticated users to /login */}
      <Route element={<ProtectedRoute unauthenticatedElement={<Navigate to="/login" replace />} />}>
        <Route path="/" element={
          <LayoutWrapper currentPageName={mainPageKey}>
            <LazyPageWrapper><MainPage /></LazyPageWrapper>
          </LayoutWrapper>
        } />
        {Object.entries(Pages).map(([path, Page]) => (
          <Route
            key={path}
            path={`/${path}`}
            element={
              <LayoutWrapper currentPageName={path}>
                <LazyPageWrapper><Page /></LazyPageWrapper>
              </LayoutWrapper>
            }
          />
        ))}
        <Route
          path="/Companies"
          element={
            <LayoutWrapper currentPageName="Companies">
              <LazyPageWrapper><Companies /></LazyPageWrapper>
            </LayoutWrapper>
          }
        />
        <Route
          path="/SquareSyncAudit"
          element={
            <LayoutWrapper currentPageName="SquareSyncAudit">
              <LazyPageWrapper><SquareSyncAudit /></LazyPageWrapper>
            </LayoutWrapper>
          }
        />
        <Route
          path="/DriverScheduleCalendar"
          element={
            <LayoutWrapper currentPageName="DriverScheduleCalendar">
              <LazyPageWrapper><DriverScheduleCalendar /></LazyPageWrapper>
            </LayoutWrapper>
          }
        />
        <Route
          path="/StatHolidays"
          element={
            <LayoutWrapper currentPageName="StatHolidays">
              <LazyPageWrapper><StatHolidays /></LazyPageWrapper>
            </LayoutWrapper>
          }
        />
        <Route
          path="/secure-docs/:driverId"
          element={<LazyPageWrapper><SecureDocViewer /></LazyPageWrapper>}
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