import React from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Download, ChevronDown } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { format } from "date-fns";
import { userHasRole } from "../utils/userRoles";

export default function ExportRouteButton({ currentUser, driverFilter, selectedDate, driverFilteredDeliveries }) {
  const finishedStatuses = ['completed','failed','cancelled','returned'];
  const isRouteComplete = (driverFilteredDeliveries || []).length > 0 &&
    (driverFilteredDeliveries || []).every(d => d && finishedStatuses.includes(d.status));
  const currentPeriod = (new Date().getHours() >= 15) ? 'PM' : 'AM';
  const hasAnyInCurrentPeriod = (driverFilteredDeliveries || []).some(d => d?.ampm_deliveries === currentPeriod);
  const hasPendingInCurrentPeriod = (driverFilteredDeliveries || []).some(d =>
    d?.ampm_deliveries === currentPeriod && !finishedStatuses.includes(d?.status)
  );

  const driverBtnDisabled = !isRouteComplete || driverFilter === 'all' || (driverFilteredDeliveries || []).length === 0;
  const preRouteDisabled = driverFilter === 'all' || !hasAnyInCurrentPeriod || !hasPendingInCurrentPeriod;
  const postRouteDisabled = driverFilter === 'all' || !isRouteComplete;

  const handleExport = async (type) => {
    const driverId = driverFilter;
    if (!driverId || driverId === 'all') { alert('Select a driver first'); return; }
    const dateStr = selectedDate ? format(selectedDate, 'yyyy-MM-dd') : format(new Date(), 'yyyy-MM-dd');

    const payload = {
      driverId,
      deliveryDate: dateStr,
      manifestType: type,              // 'pre-route' | 'post-route'
      ampm: type === 'pre-route' ? currentPeriod : undefined
    };

    const res = await base44.functions.invoke('generateRouteManifest', payload);
    const data = res?.data || res;

    // If backend returned JSON error
    if (data && typeof data === 'object' && !(data instanceof ArrayBuffer) && !('byteLength' in (data || {}))) {
      if (data?.error) { alert(data.error); return; }
    }

    const blob = new Blob([data], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `route-${type}-${dateStr}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const isDispatcher = userHasRole(currentUser, 'dispatcher') || userHasRole(currentUser, 'admin');
  const isDriver = userHasRole(currentUser, 'driver') && !userHasRole(currentUser, 'admin') && !userHasRole(currentUser, 'dispatcher');

  if (isDispatcher) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" className="gap-2">
            <Download className="w-4 h-4" />
            Export Route
            <ChevronDown className="w-4 h-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem disabled={preRouteDisabled} onClick={() => handleExport('pre-route')}>
            Pre-Route ({currentPeriod})
          </DropdownMenuItem>
          <DropdownMenuItem disabled={postRouteDisabled} onClick={() => handleExport('post-route')}>
            Post-Route (All)
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  if (isDriver) {
    return (
      <Button
        onClick={() => handleExport('post-route')}
        className="bg-emerald-600 hover:bg-emerald-700 gap-2"
        disabled={driverBtnDisabled}
      >
        <Download className="w-4 h-4" />
        Export Route
      </Button>
    );
  }

  return null;
}