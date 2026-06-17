import React from "react";
import { Button } from "@/components/ui/button";
import { Share2, RefreshCw, ListChecks } from "lucide-react";

export default function MobileBottomActions({ onSummary, onShare, onRefresh, refreshing, capturing }) {
  return (
    <div className="lg:hidden fixed bottom-0 left-0 right-0 z-20 w-full max-w-full bg-white/95 backdrop-blur border-t border-slate-200 overflow-hidden">
      <div className="w-full max-w-full px-2 py-2 grid grid-cols-3 gap-2">
        <Button size="sm" variant="outline" onClick={onSummary} className="w-full min-w-0 px-2">
          <ListChecks className="h-4 w-4 shrink-0" />
          <span className="ml-1 truncate text-xs sm:text-sm">Summary</span>
        </Button>
        <Button size="sm" variant="outline" onClick={onShare} disabled={capturing} className="w-full min-w-0 px-2">
          {capturing ? <span className="truncate text-xs sm:text-sm">Sharing...</span> : (<><Share2 className="h-4 w-4 shrink-0" /><span className="ml-1 truncate text-xs sm:text-sm">Share</span></>)}
        </Button>
        <Button size="sm" variant="default" onClick={onRefresh} disabled={refreshing} className="w-full min-w-0 px-2">
          <RefreshCw className={`h-4 w-4 shrink-0 ${refreshing ? 'animate-spin' : ''}`} />
          <span className="ml-1 truncate text-xs sm:text-sm">Refresh</span>
        </Button>
      </div>
    </div>
  );
}