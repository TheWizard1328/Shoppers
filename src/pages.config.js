import AdminUtilities from './pages/AdminUtilities';
import AppUsers from './pages/AppUsers';
import Cities from './pages/Cities';
import Dashboard from './pages/Dashboard';
import dashboardTemp from './pages/Dashboard_temp';
import Deliveries from './pages/Deliveries';
import DeliveryMetrics from './pages/DeliveryMetrics';
import DiagnosticsPage from './pages/DiagnosticsPage';
import Home from './pages/Home';
import Patients from './pages/Patients';
import Stores from './pages/Stores';
import Users from './pages/Users';
import __Layout from './Layout.jsx';


export const PAGES = {
    "AdminUtilities": AdminUtilities,
    "AppUsers": AppUsers,
    "Cities": Cities,
    "Dashboard": Dashboard,
    "Dashboard_temp": dashboardTemp,
    "Deliveries": Deliveries,
    "DeliveryMetrics": DeliveryMetrics,
    "DiagnosticsPage": DiagnosticsPage,
    "Home": Home,
    "Patients": Patients,
    "Stores": Stores,
    "Users": Users,
}

export const pagesConfig = {
    mainPage: "Dashboard",
    Pages: PAGES,
    Layout: __Layout,
};