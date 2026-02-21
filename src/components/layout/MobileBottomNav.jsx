import React, { useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { LayoutDashboard, Users, Package, Settings } from 'lucide-react';
import { motion } from 'framer-motion';
import { useMobileNav } from '../utils/MobileNavContext';

export default function MobileBottomNav({ currentPageName }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { tabState, getMainTab } = useMobileNav();
  
  const navItems = [
    {
      name: 'Dashboard',
      icon: LayoutDashboard,
      tabName: 'Dashboard'
    },
    {
      name: 'Patients',
      icon: Users,
      tabName: 'Patients'
    },
    {
      name: 'Routes',
      icon: Package,
      tabName: 'Deliveries'
    },
    {
      name: 'Settings',
      icon: Settings,
      tabName: 'DeviceSettings'
    }
  ];

  // CRITICAL: Get main tab from current page OR location pathname for nested routes
  const mainTab = React.useMemo(() => {
    const calculatedTab = getMainTab(currentPageName);
    if (calculatedTab) return calculatedTab;
    
    // Fallback: Check pathname for nested routes
    const pathname = location.pathname.split('/').pop() || 'Dashboard';
    return getMainTab(pathname) || calculatedTab;
  }, [currentPageName, location.pathname, getMainTab]);

  const handleTabClick = useCallback((tabName) => {
    // If clicking the active tab, go to its root
    if (mainTab === tabName) {
      navigate(createPageUrl(tabName));
    } else {
      // Otherwise, navigate to the saved path or root
      navigate(tabState[tabName]?.path || createPageUrl(tabName));
    }
  }, [mainTab, navigate, tabState]);

  return (
    <motion.div
      initial={{ y: 100 }}
      animate={{ y: 0 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      className="fixed bottom-0 left-0 right-0 z-[1000] border-t"
      style={{ 
        background: 'var(--bg-white)', 
        borderColor: 'var(--border-slate-200)',
        paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom, 0px))'
      }}
    >
      <nav className="flex items-center justify-around px-2 py-2 select-none">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = mainTab === item.tabName;
          
          return (
            <motion.button
              key={item.name}
              onClick={() => handleTabClick(item.tabName)}
              whileTap={{ scale: 0.95 }}
              className={`flex flex-col items-center justify-center gap-1 px-3 py-1.5 rounded-lg transition-colors select-none ${
                isActive 
                  ? 'text-emerald-600' 
                  : 'text-slate-500 hover:text-slate-900 hover:bg-slate-50'
              }`}
            >
              <Icon className={`w-5 h-5 ${isActive ? 'fill-emerald-100' : ''}`} />
              <span className="text-[10px] font-medium">{item.name}</span>
            </motion.button>
          );
        })}
      </nav>
    </motion.div>
  );
}