import React from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import SidebarDivider from '@/components/layout/SidebarDivider';
import SidebarSectionLabel from '@/components/layout/SidebarSectionLabel';

export default function AdminNavigationSection({
  adminNavigationItems,
  currentPageName,
  constructUrlWithParams,
  setSidebarOpen
}) {
  return (
    <div className="mt-2">
      <SidebarDivider />
      <SidebarSectionLabel>Admin</SidebarSectionLabel>
      <div className="space-y-1">
        {adminNavigationItems.map((item) => (
          <Link
            key={item.title}
            to={constructUrlWithParams(item.url)}
            onClick={() => setSidebarOpen(false)}
            className={`px-4 rounded-xl flex items-center gap-3 transition-all duration-200 ${
              currentPageName === item.pageName ? 'shadow-sm' : 'hover:opacity-80'
            }`}
            style={currentPageName === item.pageName ? {
              background: 'var(--bg-slate-100)',
              color: 'var(--text-slate-900)'
            } : {
              color: 'var(--text-slate-600)'
            }}
          >
            {item.icon && <item.icon className="w-5 h-5" />}
            <span className="font-semibold">{item.title}</span>
            {item.count !== undefined && (
              <Badge
                variant="secondary"
                className="ml-auto justify-center w-[50px] rounded-[10px]"
                style={{ background: 'var(--bg-slate-200)', color: 'var(--text-slate-600)' }}
              >
                {item.count}
              </Badge>
            )}
          </Link>
        ))}
      </div>
    </div>
  );
}