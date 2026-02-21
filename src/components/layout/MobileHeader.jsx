import React, { useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { ArrowLeft, Menu, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { motion } from 'framer-motion';

const ROOT_PAGES = ['Dashboard', 'Patients', 'Deliveries', 'DeviceSettings'];

export default function MobileHeader({ 
  logo, 
  sidebarOpen, 
  onSidebarToggle, 
  branding,
  unreadMessageCount,
  onMessagingClick,
  isMobile,
  isTabletPortrait
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const [showBackButton, setShowBackButton] = useState(false);

  // Detect if we're on a nested route
  useEffect(() => {
    const currentPage = location.pathname.split('/').pop() || 'Dashboard';
    const isRootPage = ROOT_PAGES.includes(currentPage);
    setShowBackButton(!isRootPage);
  }, [location.pathname]);

  const handleBack = () => {
    navigate(-1);
  };

  if (!isMobile && !isTabletPortrait) {
    return null;
  }

  return (
    <motion.header
      initial={{ y: -60 }}
      animate={{ y: 0 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      data-mobile-header
      className="mobile-header border-b px-4 py-3 sticky top-0 z-50"
      style={{ 
        borderColor: 'var(--border-slate-200)', 
        background: 'var(--bg-white)',
        paddingTop: 'calc(0.75rem + max(0, env(safe-area-inset-top, 0px)))',
        paddingBottom: 'calc(0.75rem)'
      }}
    >
      <div className="w-full flex items-center justify-between gap-2">
        <div className="flex items-center gap-1 flex-shrink-0">
          <Button
            onClick={onSidebarToggle}
            variant="ghost"
            size="icon"
            className="p-2 hover:bg-slate-100 rounded-lg transition-colors flex-shrink-0 select-none"
          >
            {sidebarOpen ? (
              <X className="w-6 h-6 text-slate-700" />
            ) : showBackButton ? (
              <ArrowLeft className="w-6 h-6 text-slate-700" onClick={(e) => { e.stopPropagation(); handleBack(); }} />
            ) : (
              <Menu className="w-6 h-6 text-slate-700" />
            )}
          </Button>

          {/* Logo - Hidden when back button is showing */}
          {!showBackButton && (
            <div className="flex items-center gap-2 flex-shrink-0">
              <img
                src={logo || "https://cdn-icons-png.flaticon.com/512/3843/3843479.png"}
                alt="Company Logo"
                className="w-8 h-8 rounded object-contain"
                style={{ filter: 'var(--image-filter, none)' }}
              />
            </div>
          )}
        </div>

        {/* Right side - User avatar + indicators */}
        <div className="flex-1" />

        <div className="flex items-center gap-2 flex-shrink-0">
          {unreadMessageCount > 0 && (
            <span className="min-w-[18px] h-[18px] bg-blue-500 text-xs font-bold rounded-full flex items-center justify-center px-1 border-2 border-white select-none" style={{ color: '#ffffff' }}>
              {unreadMessageCount > 9 ? '9+' : unreadMessageCount}
            </span>
          )}
        </div>
      </div>
    </motion.header>
  );
}