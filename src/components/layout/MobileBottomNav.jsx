import React from 'react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { userHasRole } from '@/components/utils/userRoles';
import {
  LayoutDashboard,
  Users,
  Package,
  CreditCard,
  DollarSign,
  Settings,
} from 'lucide-react';

const PAGE_SCROLL_POSITIONS = {};

export default function MobileBottomNav({ currentUser, currentPageName }) {
   if (!currentUser) return null;

   const isDriver = userHasRole(currentUser, 'driver');
   const isDispatcher = userHasRole(currentUser, 'dispatcher');
   const isAdmin = userHasRole(currentUser, 'admin');

   let navItems = [];

   if (isDriver && !isAdmin) {
     navItems = [
       { name: 'Dashboard', page: 'Dashboard', icon: LayoutDashboard },
       { name: 'Routes', page: 'Deliveries', icon: Package },
       { name: 'Square COD', page: 'SquareManagement', icon: CreditCard },
       { name: 'Payroll', page: 'DriverPayroll', icon: DollarSign },
       { name: 'Settings', page: 'DeviceSettings', icon: Settings },
     ];
   } else if (isDispatcher && !isAdmin) {
     navItems = [
       { name: 'Dashboard', page: 'Dashboard', icon: LayoutDashboard },
       { name: 'Patients', page: 'Patients', icon: Users },
       { name: 'Routes', page: 'Deliveries', icon: Package },
       { name: 'Settings', page: 'DeviceSettings', icon: Settings },
     ];
   } else if (isAdmin) {
     navItems = [
       { name: 'Dashboard', page: 'Dashboard', icon: LayoutDashboard },
       { name: 'Patients', page: 'Patients', icon: Users },
       { name: 'Routes', page: 'Deliveries', icon: Package },
       { name: 'Square COD', page: 'SquareManagement', icon: CreditCard },
       { name: 'Payroll', page: 'DriverPayroll', icon: DollarSign },
       { name: 'Settings', page: 'DeviceSettings', icon: Settings },
     ];
   }

   const navRef = React.useRef(null);
   React.useEffect(() => {
     const setVar = () => {
       const el = navRef.current;
       const h = el ? Math.ceil(el.getBoundingClientRect().height) : 0;
       document.documentElement.style.setProperty('--bottom-nav-height', `${h}px`);
     };
     setVar();
     window.addEventListener('resize', setVar);
     let ro;
     if ('ResizeObserver' in window && navRef.current) {
       ro = new ResizeObserver(setVar);
       ro.observe(navRef.current);
     }
     return () => {
       window.removeEventListener('resize', setVar);
       if (ro) ro.disconnect();
     };
   }, []);

   React.useEffect(() => {
     // Save scroll position when leaving a page
     return () => {
       const mainContent = document.querySelector('main') || document.querySelector('[data-page-content]');
       if (mainContent && currentPageName) {
         PAGE_SCROLL_POSITIONS[currentPageName] = mainContent.scrollTop;
       }
     };
   }, [currentPageName]);

   React.useEffect(() => {
     // Restore scroll position when entering a page
     const timer = setTimeout(() => {
       const mainContent = document.querySelector('main') || document.querySelector('[data-page-content]');
       if (mainContent && PAGE_SCROLL_POSITIONS[currentPageName]) {
         mainContent.scrollTop = PAGE_SCROLL_POSITIONS[currentPageName];
       }
     }, 0);
     return () => clearTimeout(timer);
   }, [currentPageName]);

   return (
     <nav
       ref={navRef}
       data-mobile-bottom-nav
       className="fixed bottom-0 left-0 right-0 z-[150] border-t"
       style={{
         background: 'var(--bg-white)',
         borderColor: 'var(--border-slate-200)',
         boxShadow: '0 -2px 10px var(--shadow-color)',
         paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom, 0px))',
       }}
     >
       <div
         className="flex overflow-x-auto custom-scrollbar"
         style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
       >
         {navItems.map((item) => {
           const isActive = currentPageName === item.page;
           const Icon = item.icon;
           return (
             <Link
               key={item.name}
               to={createPageUrl(item.page)}
               className="flex flex-col items-center justify-center py-2 px-3 flex-shrink-0 transition-colors"
               style={{
                 minWidth: `${100 / Math.min(navItems.length, 5)}vw`,
                 color: isActive ? '#10b981' : 'var(--text-slate-500)',
               }}
               onClick={() => {
                 const mainContent = document.querySelector('main') || document.querySelector('[data-page-content]');
                 if (mainContent && currentPageName) {
                   PAGE_SCROLL_POSITIONS[currentPageName] = mainContent.scrollTop;
                 }
               }}
             >
               <Icon
                 className="w-5 h-5 mb-0.5"
                 style={{ color: isActive ? '#10b981' : 'var(--text-slate-500)' }}
               />
               <span
                 className="text-xs font-medium truncate"
                 style={{ color: isActive ? '#10b981' : 'var(--text-slate-500)', maxWidth: '80px' }}
               >
                 {item.name}
               </span>
               {isActive && (
                 <div className="w-1 h-1 rounded-full bg-emerald-500 mt-0.5" />
               )}
             </Link>
           );
         })}
       </div>
     </nav>
   );
 }