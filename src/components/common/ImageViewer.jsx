import React from 'react';
import ReactDOM from 'react-dom';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function ImageViewer({ imageUrl, title = 'Image', onClose }) {
  if (!imageUrl) return null;

  return ReactDOM.createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.9)' }}
      onClick={onClose}
    >
      <div
        className="max-w-2xl max-h-[90vh] flex flex-col bg-black rounded-lg overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header with close button */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
          <h3 className="text-white font-semibold">{title}</h3>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="text-white hover:bg-slate-800"
          >
            <X className="w-5 h-5" />
          </Button>
        </div>

        {/* Image container */}
        <div className="flex-1 overflow-auto flex items-center justify-center">
          <img
            src={imageUrl}
            alt={title}
            className="max-w-full max-h-full object-contain"
          />
        </div>
      </div>
    </div>,
    document.body
  );
}