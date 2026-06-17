import React, { useState, useMemo } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Search, ArrowUpDown, ArrowUp, ArrowDown, ChevronLeft, ChevronRight, Calendar } from "lucide-react";
import { format } from "date-fns";

export default function DeliveryDataTable({ deliveries, patients, stores, drivers, onEdit, onDelete }) {
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [driverFilter, setDriverFilter] = useState("all");
  const [storeFilter, setStoreFilter] = useState("all");
  const [dateFilter, setDateFilter] = useState("");
  const [sortField, setSortField] = useState("delivery_date");
  const [sortDirection, setSortDirection] = useState("desc");
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 50;

  const statusConfig = {
    'pending': { label: 'Pending', color: 'bg-blue-100 text-blue-800' },
    'Ready For Pickup': { label: 'Ready For Pickup', color: 'bg-blue-100 text-blue-800' },
    'in_transit': { label: 'In Transit', color: 'bg-purple-100 text-purple-800' },
    'completed': { label: 'Completed', color: 'bg-emerald-100 text-emerald-800' },
    'picked_up': { label: 'Picked Up', color: 'bg-emerald-100 text-emerald-800' },
    'failed': { label: 'Failed', color: 'bg-red-100 text-red-800' },
    'cancelled': { label: 'Cancelled', color: 'bg-red-100 text-red-800' },
  };

  // Filtered and sorted data
  const filteredAndSortedDeliveries = useMemo(() => {
    let filtered = deliveries;

    // Search filter
    if (searchTerm) {
      const lowerSearch = searchTerm.toLowerCase();
      filtered = filtered.filter(delivery => {
        const patient = patients.find(p => p.id === delivery.patient_id);
        const store = stores.find(s => s.id === delivery.store_id);
        
        return (
          (delivery.delivery_id || "").toLowerCase().includes(lowerSearch) ||
          (delivery.tracking_number || "").toLowerCase().includes(lowerSearch) ||
          (patient?.full_name || "").toLowerCase().includes(lowerSearch) ||
          (patient?.patient_id || "").toLowerCase().includes(lowerSearch) ||
          (store?.name || "").toLowerCase().includes(lowerSearch) ||
          (delivery.driver_name || "").toLowerCase().includes(lowerSearch)
        );
      });
    }

    // Status filter
    if (statusFilter !== "all") {
      filtered = filtered.filter(delivery => delivery.status === statusFilter);
    }

    // Driver filter
    if (driverFilter !== "all") {
      filtered = filtered.filter(delivery => delivery.driver_name === driverFilter);
    }

    // Store filter
    if (storeFilter !== "all") {
      filtered = filtered.filter(delivery => delivery.store_id === storeFilter);
    }

    // Date filter
    if (dateFilter) {
      filtered = filtered.filter(delivery => delivery.delivery_date === dateFilter);
    }

    // Sort
    const sorted = [...filtered].sort((a, b) => {
      let aVal = a[sortField] || "";
      let bVal = b[sortField] || "";

      // Handle dates
      if (sortField === "delivery_date" || sortField === "created_date" || sortField === "actual_delivery_time") {
        aVal = aVal ? new Date(aVal).getTime() : 0;
        bVal = bVal ? new Date(bVal).getTime() : 0;
      }

      // Handle strings
      if (typeof aVal === "string") {
        aVal = aVal.toLowerCase();
        bVal = bVal.toLowerCase();
      }

      if (aVal < bVal) return sortDirection === "asc" ? -1 : 1;
      if (aVal > bVal) return sortDirection === "asc" ? 1 : -1;
      return 0;
    });

    return sorted;
  }, [deliveries, patients, stores, searchTerm, statusFilter, driverFilter, storeFilter, dateFilter, sortField, sortDirection]);

  // Pagination
  const totalPages = Math.ceil(filteredAndSortedDeliveries.length / itemsPerPage);
  const paginatedDeliveries = filteredAndSortedDeliveries.slice(
    (currentPage - 1) * itemsPerPage,
    currentPage * itemsPerPage
  );

  const handleSort = (field) => {
    if (sortField === field) {
      setSortDirection(sortDirection === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDirection("asc");
    }
  };

  const SortIcon = ({ field }) => {
    if (sortField !== field) return <ArrowUpDown className="w-4 h-4 text-slate-400" />;
    return sortDirection === "asc" 
      ? <ArrowUp className="w-4 h-4 text-emerald-600" />
      : <ArrowDown className="w-4 h-4 text-emerald-600" />;
  };

  const getPatientName = (patientId) => {
    if (!patientId) return "Store Pickup";
    const patient = patients.find(p => p.id === patientId);
    return patient?.full_name || "Unknown";
  };

  const getStoreName = (storeId) => {
    const store = stores.find(s => s.id === storeId);
    return store?.name || "Unknown";
  };

  // Get unique drivers for filter
  const uniqueDrivers = useMemo(() => {
    const driverNames = new Set(deliveries.map(d => d.driver_name).filter(Boolean));
    return Array.from(driverNames).sort();
  }, [deliveries]);

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
        <div className="md:col-span-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <Input
              placeholder="Search by patient, store, driver, tracking#..."
              value={searchTerm}
              onChange={(e) => {
                setSearchTerm(e.target.value);
                setCurrentPage(1);
              }}
              className="pl-10"
            />
          </div>
        </div>

        <Input
          type="date"
          value={dateFilter}
          onChange={(e) => {
            setDateFilter(e.target.value);
            setCurrentPage(1);
          }}
          placeholder="Filter by date"
        />

        <Select value={statusFilter} onValueChange={(val) => { setStatusFilter(val); setCurrentPage(1); }}>
          <SelectTrigger>
            <SelectValue placeholder="All Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="pending">Pending</SelectItem>
            <SelectItem value="Ready For Pickup">Ready For Pickup</SelectItem>
            <SelectItem value="in_transit">In Transit</SelectItem>
            <SelectItem value="completed">Completed</SelectItem>
            <SelectItem value="picked_up">Picked Up</SelectItem>
            <SelectItem value="failed">Failed</SelectItem>
            <SelectItem value="cancelled">Cancelled</SelectItem>
          </SelectContent>
        </Select>

        <Select value={driverFilter} onValueChange={(val) => { setDriverFilter(val); setCurrentPage(1); }}>
          <SelectTrigger>
            <SelectValue placeholder="All Drivers" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Drivers</SelectItem>
            {uniqueDrivers.map(driver => (
              <SelectItem key={driver} value={driver}>{driver}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Results count */}
      <div className="text-sm text-slate-600">
        Showing {paginatedDeliveries.length} of {filteredAndSortedDeliveries.length} deliveries
        {(searchTerm || statusFilter !== "all" || driverFilter !== "all" || dateFilter) && 
          ` (filtered from ${deliveries.length} total)`
        }
      </div>

      {/* Table */}
      <div className="border rounded-lg overflow-hidden bg-white">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-slate-50 border-b">
              <tr>
                <th className="text-left p-3 font-medium text-slate-700">
                  <button
                    onClick={() => handleSort("delivery_date")}
                    className="flex items-center gap-2 hover:text-slate-900"
                  >
                    Date <SortIcon field="delivery_date" />
                  </button>
                </th>
                <th className="text-left p-3 font-medium text-slate-700">
                  <button
                    onClick={() => handleSort("tracking_number")}
                    className="flex items-center gap-2 hover:text-slate-900"
                  >
                    TR# <SortIcon field="tracking_number" />
                  </button>
                </th>
                <th className="text-left p-3 font-medium text-slate-700">
                  <button
                    onClick={() => handleSort("patient_id")}
                    className="flex items-center gap-2 hover:text-slate-900"
                  >
                    Patient <SortIcon field="patient_id" />
                  </button>
                </th>
                <th className="text-left p-3 font-medium text-slate-700">
                  <button
                    onClick={() => handleSort("store_id")}
                    className="flex items-center gap-2 hover:text-slate-900"
                  >
                    Store <SortIcon field="store_id" />
                  </button>
                </th>
                <th className="text-left p-3 font-medium text-slate-700">
                  <button
                    onClick={() => handleSort("driver_name")}
                    className="flex items-center gap-2 hover:text-slate-900"
                  >
                    Driver <SortIcon field="driver_name" />
                  </button>
                </th>
                <th className="text-left p-3 font-medium text-slate-700">
                  <button
                    onClick={() => handleSort("status")}
                    className="flex items-center gap-2 hover:text-slate-900"
                  >
                    Status <SortIcon field="status" />
                  </button>
                </th>
                <th className="text-right p-3 font-medium text-slate-700">Actions</th>
              </tr>
            </thead>
            <tbody>
              {paginatedDeliveries.map(delivery => (
                <tr key={delivery.id} className="border-b hover:bg-slate-50">
                  <td className="p-3 text-sm">
                    <div className="space-y-1">
                      <div>{format(new Date(delivery.delivery_date + 'T00:00:00Z'), 'MMM d, yyyy')}</div>
                      {delivery.actual_delivery_time && (
                        <div className="text-xs text-slate-500">
                          {format(new Date(delivery.actual_delivery_time), 'h:mm a')}
                        </div>
                      )}
                    </div>
                  </td>
                  <td className="p-3 font-mono text-sm">{delivery.tracking_number || "—"}</td>
                  <td className="p-3 text-sm">{getPatientName(delivery.patient_id)}</td>
                  <td className="p-3 text-sm text-slate-600">{getStoreName(delivery.store_id)}</td>
                  <td className="p-3 text-sm text-slate-600">{delivery.driver_name || "Unassigned"}</td>
                  <td className="p-3">
                    <Badge className={statusConfig[delivery.status]?.color || "bg-slate-100 text-slate-800"}>
                      {statusConfig[delivery.status]?.label || delivery.status}
                    </Badge>
                  </td>
                  <td className="p-3">
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="ghost" onClick={() => onEdit(delivery)}>
                        Edit
                      </Button>
                      <Button 
                        size="sm" 
                        variant="ghost" 
                        onClick={() => onDelete(delivery.id)}
                        className="text-red-600 hover:text-red-700"
                      >
                        Delete
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <div className="text-sm text-slate-600">
            Page {currentPage} of {totalPages}
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
              disabled={currentPage === 1}
            >
              <ChevronLeft className="w-4 h-4" />
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
              disabled={currentPage === totalPages}
            >
              Next
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}