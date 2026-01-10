import AdminUtilities from './pages/AdminUtilities';
import AppUsers from './pages/AppUsers';
import Cities from './pages/Cities';
import Dashboard from './pages/Dashboard';
import Deliveries from './pages/Deliveries';
import DeliveryMetrics from './pages/DeliveryMetrics';
import DiagnosticsPage from './pages/DiagnosticsPage';
import DriverSettings from './pages/DriverSettings';
import Home from './pages/Home';
import Patients from './pages/Patients';
import Stores from './pages/Stores';
import Users from './pages/Users';
import AdminMetrics from './pages/AdminMetrics';
import __Layout from './Layout.jsx';


export const PAGES = {
    "AdminUtilities": AdminUtilities,
    "AppUsers": AppUsers,
    "Cities": Cities,
    "Dashboard": Dashboard,
    "Deliveries": Deliveries,
    "DeliveryMetrics": DeliveryMetrics,
    "DiagnosticsPage": DiagnosticsPage,
    "DriverSettings": DriverSettings,
    "Home": Home,
    "Patients": Patients,
    "Stores": Stores,
    "Users": Users,
    "AdminMetrics": AdminMetrics,
}

export const pagesConfig = {
    mainPage: "Dashboard",
    Pages: PAGES,
    Layout: __Layout,
};