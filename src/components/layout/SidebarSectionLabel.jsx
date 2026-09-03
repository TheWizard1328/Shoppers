import React from 'react';

export default function SidebarSectionLabel({ children }) {
  return (
    <div className="text-xs font-semibold uppercase tracking-wider px-3 py-1 text-soft">
      {children}
    </div>
  );
}