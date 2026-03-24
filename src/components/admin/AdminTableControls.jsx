import React, { useState, useEffect } from 'react';
import { Settings } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Checkbox } from '@/components/ui/checkbox';

export const ResizableColumnHeader = ({ children, onResize, width, minWidth = 80 }) => {
  const [isResizing, setIsResizing] = useState(false);
  const [startX, setStartX] = useState(0);
  const [startWidth, setStartWidth] = useState(width);

  const handleMouseDown = (e) => {
    e.preventDefault();
    setIsResizing(true);
    setStartX(e.clientX);
    setStartWidth(width);
  };

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e) => {
      const delta = e.clientX - startX;
      const newWidth = Math.max(minWidth, startWidth + delta);
      onResize(newWidth);
    };

    const handleMouseUp = () => setIsResizing(false);

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing, startX, startWidth, minWidth, onResize]);

  return (
    <th className="relative p-2 text-left group" style={{ width: `${width}px`, minWidth: `${minWidth}px`, maxWidth: `${width}px` }}>
      {children}
      <div
        className="absolute right-0 top-0 bottom-0 w-1 bg-transparent hover:bg-emerald-300 transition-colors cursor-col-resize z-10"
        onMouseDown={handleMouseDown}
        style={{ userSelect: 'none' }}
      />
    </th>
  );
};

export const ColumnVisibilityControl = ({ config, visibleColumns, onToggle }) => {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)', color: 'var(--text-slate-900)' }}>
          <Settings className="w-4 h-4" />
          Columns ({visibleColumns.length}/{config.length})
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-2" align="end" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
        <div className="space-y-2">
          <h4 className="font-semibold text-sm mb-3 px-1" style={{ color: 'var(--text-slate-900)' }}>Toggle Columns</h4>
          {config.map((column) => (
            <div key={column.id} className="flex items-center gap-2 p-1 rounded-sm">
              <Checkbox
                id={`column-${column.id}`}
                checked={visibleColumns.includes(column.id)}
                onCheckedChange={() => !column.alwaysVisible && onToggle(column.id)}
                disabled={column.alwaysVisible}
              />
              <label
                htmlFor={`column-${column.id}`}
                className="text-sm cursor-pointer"
                style={{ color: column.alwaysVisible ? 'var(--text-slate-400)' : 'var(--text-slate-900)' }}
              >
                {column.label}
                {column.alwaysVisible && ' (required)'}
              </label>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
};