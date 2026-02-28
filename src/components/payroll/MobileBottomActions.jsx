import React from "react";
import { Button } from "@/components/ui/button";
import { Share2, RefreshCw, ListChecks } from "lucide-react";

export default function MobileBottomActions({ onSummary, onShare, onRefresh, refreshing, capturing }) {
  return (
    <div className="lg:hidden fixed bottom-0 left-0 right-0 z-20 bg-white/95 backdrop-blur border-t border-slate-200">
      <div className="max-w-7xl mx-auto px-4 py-2 grid grid-cols-3 gap-2">
        <Button size="sm" variant="outline" onClick={onSummary} className="w-full">
          <ListChecks className="h-4 w-4" />
          <span className="ml-2 text-sm">Summary</span>
        </Button>
        <Button size="sm" variant="outline" onClick={onShare} disabled={capturing} className="w-full">
          {capturing ? <span className="text-sm">Sharing...</span> : (<><Share2 className="h-4 w-4" /><span className="ml-2 text-sm">Share</span></>)}
        </Button>
        <Button size="sm" variant="default" onClick={onRefresh} disabled={refreshing} className="w-full">
          <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          <span className="ml-2 text-sm">Refresh</span>
        </Button>
      </div>
    </div>
  );
}