import Dashboard from './pages/Dashboard';
import Deliveries from './pages/Deliveries';
import Patients from './pages/Patients';
import Stores from './pages/Stores';
import Users from './pages/Users';
import DeliveryMetrics from './pages/DeliveryMetrics';
import Cities from './pages/Cities';
import AdminUtilities from './pages/AdminUtilities';
import DiagnosticsPage from './pages/DiagnosticsPage';
import AppUsers from './pages/AppUsers';
import __Layout from './Layout.jsx';


export const PAGES = {
    "Dashboard": Dashboard,
    "Deliveries": Deliveries,
    "Patients": Patients,
    "Stores": Stores,
    "Users": Users,
    "DeliveryMetrics": DeliveryMetrics,
    "Cities": Cities,
    "AdminUtilities": AdminUtilities,
    "DiagnosticsPage": DiagnosticsPage,
    "AppUsers": AppUsers,
}

export const pagesConfig = {
    mainPage: "Dashboard",
    Pages: PAGES,
    Layout: __Layout,
};