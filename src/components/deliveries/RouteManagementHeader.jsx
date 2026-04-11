import React from "react";
import { format } from "date-fns";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import ExportRouteButton from "./ExportRouteButton";
import SmartRefreshIndicator from "../layout/SmartRefreshIndicator";
import { userHasRole } from "../utils/userRoles";

export default function RouteManagementHeader({
  currentUser,
  driverFilter,
  selectedDate,
  driverFilteredDeliveries,
  searchTerm,
  handleSearchChange,
  driverFilterOptions,
  handleDriverChange,
  storeFilter,
  handleStoreChange,
  routeScopedStoreOptions,
  statusFilter,
  handleStatusChange
}) {
  return (
    <>
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-4">
        <div>
          <h1 className="text-3xl font-bold flex items-baseline gap-3" style={{ color: 'var(--text-slate-900)' }}>
            <SmartRefreshIndicator inline={true} />
            Route Management
            <Badge variant="outline" className="ml-2 text-sm font-normal" style={{ background: 'var(--bg-slate-100)', color: 'var(--text-slate-700)', borderColor: 'var(--border-slate-300)' }}>
              {format(new Date(), 'MMM d, yyyy')}
            </Badge>
          </h1>
        </div>
        <div className="flex gap-3 flex-wrap items-center">
          <ExportRouteButton
            currentUser={currentUser}
            driverFilter={driverFilter}
            selectedDate={selectedDate}
            driverFilteredDeliveries={driverFilteredDeliveries}
          />
        </div>
      </div>
      <div className="flex items-center gap-3">
        <div className="relative flex-grow">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
          <Input placeholder="Search patient, address, Rx details, tracking..." value={searchTerm} onChange={(e) => handleSearchChange(e.target.value)} className="pl-10 w-full bg-slate-100 border-slate-300" />
        </div>
        <Select value={driverFilter} onValueChange={handleDriverChange}>
          <SelectTrigger className="w-[140px] bg-white border-slate-300"><SelectValue placeholder="Select driver" /></SelectTrigger>
          <SelectContent><SelectItem value="all">All Drivers</SelectItem>{driverFilterOptions.map((driver) => <SelectItem key={driver.id} value={driver.id}>{driver.label}</SelectItem>)}</SelectContent>
        </Select>
        {!userHasRole(currentUser, 'dispatcher') && (
          <Select value={storeFilter} onValueChange={handleStoreChange}>
            <SelectTrigger className="w-[160px] bg-white border-slate-300 text-slate-900 font-medium"><SelectValue placeholder="Store" /></SelectTrigger>
            <SelectContent><SelectItem value="all">All Stores</SelectItem>{routeScopedStoreOptions.map((store) => <SelectItem key={store.id} value={store.id}>{store.label}</SelectItem>)}</SelectContent>
          </Select>
        )}
        <Select value={statusFilter} onValueChange={handleStatusChange}>
          <SelectTrigger className="w-36 bg-white border-slate-300 text-slate-900 font-medium"><SelectValue placeholder="Status" /></SelectTrigger>
          <SelectContent><SelectItem value="all">All Status</SelectItem><SelectItem value="pending">Pending</SelectItem><SelectItem value="Ready For Pickup">Ready For Pickup</SelectItem><SelectItem value="picked_up">Picked Up</SelectItem><SelectItem value="in_transit">In Transit</SelectItem><SelectItem value="completed">Completed</SelectItem><SelectItem value="failed">Failed</SelectItem><SelectItem value="returned">Returned</SelectItem><SelectItem value="cancelled">Cancelled</SelectItem></SelectContent>
        </Select>
      </div>
    </>
  );
}