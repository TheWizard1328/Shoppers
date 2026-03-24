import React, { useCallback, useEffect, useRef, useState, forwardRef } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Plus } from "lucide-react";
import SpotlightOverlay from "@/components/common/SpotlightOverlay";

const AddDeliveryButton = forwardRef(function AddDeliveryButton(
  { onClick, disabled, hasRateLimitError = false },
  ref
) {
  const localRef = useRef(null);
  const buttonRef = (ref || localRef);

  const [showSpotlight, setShowSpotlight] = useState(true);
  const handleCloseSpotlight = useCallback(() => {
    setShowSpotlight(false);
  }, []);

  // Auto-show on load/refresh for 15s
  useEffect(() => {
    setShowSpotlight(true);
  }, []);

  const baseClasses = `h-8 w-8 p-0 transition-colors ${
    hasRateLimitError ? 'bg-red-500 hover:bg-red-600' : 'bg-emerald-500 hover:bg-emerald-600'
  }`;

  return (
    <>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              ref={buttonRef}
              onClick={onClick}
              size="sm"
              className={baseClasses}
              disabled={disabled}
            >
              <Plus className="w-4 h-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="center" className="relative z-[1000]">
            <div className="text-xs">Start here to add new stop locations to your driver(s).</div>
            <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-2 h-2 rotate-45 bg-white border-l border-t border-slate-200" />
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <SpotlightOverlay
        targetRef={buttonRef}
        text="Start here to add new stop locations to your driver(s)."
        visible={showSpotlight}
        onClose={handleCloseSpotlight}
        durationMs={15000}
      />
    </>
  );
});

export default AddDeliveryButton;