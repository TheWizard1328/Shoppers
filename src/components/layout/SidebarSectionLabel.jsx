import React from 'react';

export default function SidebarSectionLabel({ children }) {
  return (
    <div className="text-xs font-semibold uppercase tracking-wider px-3 py-1" style={{ color: 'var(--text-slate-500)' }}>
      {children}
    </div>
  );
}