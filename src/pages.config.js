/**
 * pages.config.js - Page routing configuration
 * 
 * This file is AUTO-GENERATED. Do not add imports or modify PAGES manually.
 * Pages are auto-registered when you create files in the ./pages/ folder.
 * 
 * THE ONLY EDITABLE VALUE: mainPage
 * This controls which page is the landing page (shown when users visit the app).
 * 
 * Example file structure:
 * 
 *   import HomePage from './pages/HomePage';
 *   import Dashboard from './pages/Dashboard';
 *   import Settings from './pages/Settings';
 *   
 *   export const PAGES = {
 *       "HomePage": HomePage,
 *       "Dashboard": Dashboard,
 *       "Settings": Settings,
 *   }
 *   
 *   export const pagesConfig = {
 *       mainPage: "HomePage",
 *       Pages: PAGES,
 *   };
 * 
 * Example with Layout (wraps all pages):
 *
 *   import Home from './pages/Home';
 *   import Settings from './pages/Settings';
 *   import __Layout from './Layout.jsx';
 *
 *   export const PAGES = {
 *       "Home": Home,
 *       "Settings": Settings,
 *   }
 *
 *   export const pagesConfig = {
 *       mainPage: "Home",
 *       Pages: PAGES,
 *       Layout: __Layout,
 *   };
 *
 * To change the main page from HomePage to Dashboard, use find_replace:
 *   Old: mainPage: "HomePage",
 *   New: mainPage: "Dashboard",
 *
 * The mainPage value must match a key in the PAGES object exactly.
 */
import AdminMetrics from './pages/AdminMetrics';
import AdminUtilities from './pages/AdminUtilities';
import AppUsers from './pages/AppUsers';
import Cities from './pages/Cities';
import Dashboard from './pages/Dashboard';
import Deliveries from './pages/Deliveries';
import DeliveryMetrics from './pages/DeliveryMetrics';
import DeviceSettings from './pages/DeviceSettings';
import DiagnosticsPage from './pages/DiagnosticsPage';
import DriverPayroll from './pages/DriverPayroll';
import DriverSettings from './pages/DriverSettings';
import Home from './pages/Home';
import Patients from './pages/Patients';
import SquareLocationConfigs from './pages/SquareLocationConfigs';
import SquareManagement from './pages/SquareManagement';
import StoreInvoices from './pages/StoreInvoices';
import Stores from './pages/Stores';
import Users from './pages/Users';
import Register from './pages/Register';
import __Layout from './Layout.jsx';


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
    "DriverSettings": DriverSettings,
    "Home": Home,
    "Patients": Patients,
    "SquareLocationConfigs": SquareLocationConfigs,
    "SquareManagement": SquareManagement,
    "StoreInvoices": StoreInvoices,
    "Stores": Stores,
    "Users": Users,
    "Register": Register,
}

export const pagesConfig = {
    mainPage: "Dashboard",
    Pages: PAGES,
    Layout: __Layout,
};