import React from "react";
import { format } from "date-fns";
import { Search } from "lucide-react";
import { motion } from "framer-motion";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import ExportRouteButton from "./ExportRouteButton";
import SmartRefreshIndicator from "../layout/SmartRefreshIndicator";
import StopDetailsPanel from "./StopDetailsPanel";
import { userHasRole } from "../utils/userRoles";

export function RouteManagementStopDetailsOverlay({
  selectedDeliveryId,
  selectedDelivery,
  selectedPatient,
  selectedStore,
  currentUser,
  onEdit,
  onEditPatient,
  onDelete,
  onRestart,
  onStatusUpdate,
  onNotesUpdate,
  onCODUpdate,
  onCreateReturn,
  onStartDelivery,
  allDeliveries,
  selectedDate,
  patients,
  stores,
  drivers,
  onDriverStatusChange,
  isMobile,
  onClose
}) {
  if (!selectedDeliveryId || !selectedDelivery) return null;

  const panelProps = {
    delivery: selectedDelivery,
    patient: selectedPatient,
    store: selectedStore,
    currentUser,
    onEdit,
    onEditPatient,
    onDelete,
    onRestart,
    onStatusUpdate,
    onNotesUpdate,
    onCODUpdate,
    onCreateReturn,
    onStartDelivery,
    allDeliveries,
    selectedDate,
    patients,
    stores,
    drivers,
    onDriverStatusChange,
    onClose
  };

  return (
    <>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        className={`${isMobile ? 'fixed' : 'absolute'} inset-0 bg-black/50 z-[200]`}
        onClick={onClose} />
      

      {isMobile ?
      <motion.div
        initial={{ y: "100%" }}
        animate={{ y: 0 }}
        exit={{ y: "100%" }}
        transition={{ type: "spring", stiffness: 300, damping: 30 }}
        className="fixed left-0 right-0 z-[201] overflow-hidden rounded-t-2xl"
        style={{ background: 'var(--bg-white)', bottom: 'var(--bottom-nav-height, 88px)', maxHeight: 'calc(100dvh - var(--mobile-header-height, 64px) - var(--bottom-nav-height, 88px) - 8px)' }}
        onClick={(e) => e.stopPropagation()}>
        
          <div className="overflow-y-auto" style={{ maxHeight: 'calc(100dvh - var(--mobile-header-height, 64px) - var(--bottom-nav-height, 88px) - 8px)' }}>
            <StopDetailsPanel {...panelProps} />
          </div>
        </motion.div> :

      <motion.div
        initial={{ x: "100%" }}
        animate={{ x: 0 }}
        exit={{ x: "100%" }}
        transition={{ type: "spring", stiffness: 300, damping: 30 }}
        className="absolute right-0 top-0 bottom-0 w-[560px] shadow-xl z-[201] overflow-hidden"
        style={{ background: 'var(--bg-white)' }}
        onClick={(e) => e.stopPropagation()}>
        
          <div className="h-full overflow-y-auto">
            <StopDetailsPanel {...panelProps} />
          </div>
        </motion.div>
      }
    </>);

}

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
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-2">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-3" style={{ color: 'var(--text-slate-900)' }}>
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
            driverFilteredDeliveries={driverFilteredDeliveries} />
          
        </div>
      </div>
      <div className="flex items-center gap-3">
        <div className="relative flex-grow">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
          <Input placeholder="Search patient, address, Rx details, tracking..." value={searchTerm} onChange={(e) => handleSearchChange(e.target.value)} className="pl-10 w-full bg-slate-100 border-slate-300" />
        </div>
        <Select value={driverFilter} onValueChange={handleDriverChange} disabled={(userHasRole(currentUser, 'driver') && !userHasRole(currentUser, 'admin')) || (userHasRole(currentUser, 'dispatcher') && !userHasRole(currentUser, 'admin'))}>
          <SelectTrigger className={`w-[140px] bg-white border-slate-300 ${(userHasRole(currentUser, 'driver') && !userHasRole(currentUser, 'admin')) || (userHasRole(currentUser, 'dispatcher') && !userHasRole(currentUser, 'admin')) ? 'opacity-60 cursor-not-allowed' : ''}`}><SelectValue placeholder="Select driver" /></SelectTrigger>
          <SelectContent><SelectItem value="all">All Drivers</SelectItem>{driverFilterOptions.map((driver) => <SelectItem key={driver.id} value={driver.id}>{driver.label}</SelectItem>)}</SelectContent>
        </Select>
        {!userHasRole(currentUser, 'dispatcher') &&
        <Select value={storeFilter} onValueChange={handleStoreChange}>
            <SelectTrigger className="w-[160px] bg-white border-slate-300 text-slate-900 font-medium"><SelectValue placeholder="Store" /></SelectTrigger>
            <SelectContent><SelectItem value="all">All Stores</SelectItem>{routeScopedStoreOptions.map((store) => <SelectItem key={store.id} value={store.id}>{store.label}</SelectItem>)}</SelectContent>
          </Select>
        }
        <Select value={statusFilter} onValueChange={handleStatusChange}>
          <SelectTrigger className="w-36 bg-white border-slate-300 text-slate-900 font-medium"><SelectValue placeholder="Status" /></SelectTrigger>
          <SelectContent><SelectItem value="all">All Status</SelectItem><SelectItem value="pending">Pending</SelectItem><SelectItem value="Ready For Pickup">Ready For Pickup</SelectItem><SelectItem value="picked_up">Picked Up</SelectItem><SelectItem value="in_transit">In Transit</SelectItem><SelectItem value="completed">Completed</SelectItem><SelectItem value="failed">Failed</SelectItem><SelectItem value="returned">Returned</SelectItem><SelectItem value="cancelled">Cancelled</SelectItem></SelectContent>
        </Select>
      </div>
    </>);

}