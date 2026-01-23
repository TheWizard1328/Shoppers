import AdminUtilities from './pages/AdminUtilities';
import AppUsers from './pages/AppUsers';
import Cities from './pages/Cities';
import Dashboard from './pages/Dashboard';
import Deliveries from './pages/Deliveries';
import DeliveryMetrics from './pages/DeliveryMetrics';
import DiagnosticsPage from './pages/DiagnosticsPage';
import DriverPayroll from './pages/DriverPayroll';
import DriverSettings from './pages/DriverSettings';
import Home from './pages/Home';
import Patients from './pages/Patients';
import SquareLocationConfigs from './pages/SquareLocationConfigs';
import SquareManagement from './pages/SquareManagement';
import Stores from './pages/Stores';
import Users from './pages/Users';
import __Layout from './Layout.jsx';


export const PAGES = {
    "AdminUtilities": AdminUtilities,
    "AppUsers": AppUsers,
    "Cities": Cities,
    "Dashboard": Dashboard,
    "Deliveries": Deliveries,
    "DeliveryMetrics": DeliveryMetrics,
    "DiagnosticsPage": DiagnosticsPage,
    "DriverPayroll": DriverPayroll,
    "DriverSettings": DriverSettings,
    "Home": Home,
    "Patients": Patients,
    "SquareLocationConfigs": SquareLocationConfigs,
    "SquareManagement": SquareManagement,
    "Stores": Stores,
    "Users": Users,
}

export const pagesConfig = {
    mainPage: "Dashboard",
    Pages: PAGES,
    Layout: __Layout,
};