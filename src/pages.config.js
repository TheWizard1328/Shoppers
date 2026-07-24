/**
 * pages.config.js - Page routing configuration
 * 
 * Pages are lazy-loaded via React.lazy for code splitting.
 * This keeps the initial bundle small — only the active page's chunk loads.
 */

import { lazy } from 'react';
import __Layout from './Layout.jsx';

// Lazy-load all pages — each becomes a separate chunk loaded on demand
const AdminMetrics = lazy(() => import('./pages/AdminMetrics'));
const AdminUtilities = lazy(() => import('./pages/AdminUtilities'));
const AppUsers = lazy(() => import('./pages/AppUsers'));
const Cities = lazy(() => import('./pages/Cities'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Deliveries = lazy(() => import('./pages/Deliveries'));
const DeliveryMetrics = lazy(() => import('./pages/DeliveryMetrics'));
const DeviceSettings = lazy(() => import('./pages/DeviceSettings'));
const DiagnosticsPage = lazy(() => import('./pages/DiagnosticsPage'));
const DriverPayroll = lazy(() => import('./pages/DriverPayroll'));
const Documents = lazy(() => import('./pages/Documents'));
const DriverSettings = lazy(() => import('./pages/DriverSettings'));
const Home = lazy(() => import('./pages/Home'));
const PatientActivityReview = lazy(() => import('./pages/PatientActivityReview'));
const Patients = lazy(() => import('./pages/Patients'));
const Settings = lazy(() => import('./pages/Settings'));
const SquareLocationConfigs = lazy(() => import('./pages/SquareLocationConfigs'));
const SquareManagement = lazy(() => import('./pages/SquareManagement'));
const StoreInvoices = lazy(() => import('./pages/StoreInvoices'));
const Stores = lazy(() => import('./pages/Stores'));

export const PAGES = {
    "AdminMetrics": AdminMetrics,
    "AdminUtilities": AdminUtilities,
    "AppUsers": AppUsers,
    "Cities": Cities,
    "Dashboard": Dashboard,
    "Deliveries": Deliveries,
    "DeliveryMetrics": DeliveryMetrics,
    "DeviceSettings": DeviceSettings,
    "DiagnosticsPage": DiagnosticsPage,
    "DriverPayroll": DriverPayroll,
    "Documents": Documents,
    "DriverSettings": DriverSettings,
    "Home": Home,
    "PatientActivityReview": PatientActivityReview,
    "Patients": Patients,
    "Settings": Settings,
    "SquareLocationConfigs": SquareLocationConfigs,
    "SquareManagement": SquareManagement,
    "StoreInvoices": StoreInvoices,
    "Stores": Stores,
}

export const pagesConfig = {
    mainPage: "Dashboard",
    Pages: PAGES,
    Layout: __Layout,
};
