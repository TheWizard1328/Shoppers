import React from 'react';
import { Button } from '@/components/ui/button';

export default function AppLoadingScreen({ showRetryHint, onRetry }) {
  return (
    <div className="h-screen flex items-center justify-center bg-slate-50">
      <div className="text-center px-6">
        <div className="animate-spin w-12 h-12 border-4 border-emerald-500 border-t-transparent rounded-full mx-auto mb-4"></div>
        <p className="text-slate-600 text-lg font-medium">Loading RxDeliver...</p>
        {showRetryHint && (
          <div className="mt-4 space-y-3">
            <p className="text-sm text-slate-500">If loading stays stuck, press F5 to retry.</p>
            <Button variant="outline" onClick={onRetry}>Retry now</Button>
          </div>
        )}
      </div>
    </div>
  );
}