import React, { useState, useMemo } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Search, ArrowUpDown, ArrowUp, ArrowDown, ChevronLeft, ChevronRight } from "lucide-react";
import { format } from "date-fns";

export default function PatientDataTable({ patients, stores, onEdit, onDelete }) {
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [storeFilter, setStoreFilter] = useState("all");
  const [sortField, setSortField] = useState("full_name");
  const [sortDirection, setSortDirection] = useState("asc");
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 50;

  // Filtered and sorted data
  const filteredAndSortedPatients = useMemo(() => {
    let filtered = patients;

    // Search filter
    if (searchTerm) {
      const lowerSearch = searchTerm.toLowerCase();
      filtered = filtered.filter(patient => 
        (patient.full_name || "").toLowerCase().includes(lowerSearch) ||
        (patient.patient_id || "").toLowerCase().includes(lowerSearch) ||
        (patient.address || "").toLowerCase().includes(lowerSearch) ||
        (patient.phone || "").toLowerCase().includes(lowerSearch)
      );
    }

    // Status filter
    if (statusFilter !== "all") {
      filtered = filtered.filter(patient => patient.status === statusFilter);
    }

    // Store filter
    if (storeFilter !== "all") {
      filtered = filtered.filter(patient => patient.store_id === storeFilter);
    }

    // Sort
    const sorted = [...filtered].sort((a, b) => {
      let aVal = a[sortField] || "";
      let bVal = b[sortField] || "";

      // Handle dates
      if (sortField === "created_date" || sortField === "last_delivery_date" || sortField === "last_login_date") {
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
  }, [patients, searchTerm, statusFilter, storeFilter, sortField, sortDirection]);

  // Pagination
  const totalPages = Math.ceil(filteredAndSortedPatients.length / itemsPerPage);
  const paginatedPatients = filteredAndSortedPatients.slice(
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

  const getStoreName = (storeId) => {
    const store = stores.find(s => s.id === storeId);
    return store?.name || "Unknown";
  };

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="md:col-span-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <Input
              placeholder="Search by name, ID, address, phone..."
              value={searchTerm}
              onChange={(e) => {
                setSearchTerm(e.target.value);
                setCurrentPage(1);
              }}
              className="pl-10"
            />
          </div>
        </div>

        <Select value={statusFilter} onValueChange={(val) => { setStatusFilter(val); setCurrentPage(1); }}>
          <SelectTrigger>
            <SelectValue placeholder="All Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="inactive">Inactive</SelectItem>
          </SelectContent>
        </Select>

        <Select value={storeFilter} onValueChange={(val) => { setStoreFilter(val); setCurrentPage(1); }}>
          <SelectTrigger>
            <SelectValue placeholder="All Stores" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Stores</SelectItem>
            {stores.map(store => (
              <SelectItem key={store.id} value={store.id}>{store.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Results count */}
      <div className="text-sm text-slate-600">
        Showing {paginatedPatients.length} of {filteredAndSortedPatients.length} patients
        {searchTerm && ` (filtered from ${patients.length} total)`}
      </div>

      {/* Table */}
      <div className="border rounded-lg overflow-hidden bg-white">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-slate-50 border-b">
              <tr>
                <th className="text-left p-3 font-medium text-slate-700">
                  <button
                    onClick={() => handleSort("patient_id")}
                    className="flex items-center gap-2 hover:text-slate-900"
                  >
                    PID <SortIcon field="patient_id" />
                  </button>
                </th>
                <th className="text-left p-3 font-medium text-slate-700">
                  <button
                    onClick={() => handleSort("full_name")}
                    className="flex items-center gap-2 hover:text-slate-900"
                  >
                    Name <SortIcon field="full_name" />
                  </button>
                </th>
                <th className="text-left p-3 font-medium text-slate-700">
                  <button
                    onClick={() => handleSort("address")}
                    className="flex items-center gap-2 hover:text-slate-900"
                  >
                    Address <SortIcon field="address" />
                  </button>
                </th>
                <th className="text-left p-3 font-medium text-slate-700">
                  <button
                    onClick={() => handleSort("phone")}
                    className="flex items-center gap-2 hover:text-slate-900"
                  >
                    Phone <SortIcon field="phone" />
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
                    onClick={() => handleSort("last_delivery_date")}
                    className="flex items-center gap-2 hover:text-slate-900"
                  >
                    Last Delivery <SortIcon field="last_delivery_date" />
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
                <th className="text-left p-3 font-medium text-slate-700">
                  <button
                    onClick={() => handleSort("last_login_date")}
                    className="flex items-center gap-2 hover:text-slate-900"
                  >
                    Portal Login <SortIcon field="last_login_date" />
                  </button>
                </th>
                <th className="text-right p-3 font-medium text-slate-700">Actions</th>
              </tr>
            </thead>
            <tbody>
              {paginatedPatients.map(patient => (
                <tr key={patient.id} className="border-b hover:bg-slate-50">
                  <td className="p-3 font-mono text-sm">{patient.patient_id || "—"}</td>
                  <td className="p-3 font-medium">{patient.full_name}</td>
                  <td className="p-3 text-slate-600 text-sm">
                    {patient.address}
                    {patient.unit_number && ` ${patient.unit_number}`}
                  </td>
                  <td className="p-3 text-slate-600 text-sm">{patient.phone || "—"}</td>
                  <td className="p-3 text-slate-600 text-sm">{getStoreName(patient.store_id)}</td>
                  <td className="p-3 text-slate-600 text-sm">
                    {patient.last_delivery_date 
                      ? format(new Date(patient.last_delivery_date), 'MMM d, yyyy')
                      : "—"
                    }
                  </td>
                  <td className="p-3">
                    <Badge className={patient.status === "active" ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-800"}>
                      {patient.status || "active"}
                    </Badge>
                  </td>
                  <td className="p-3 text-slate-600 text-sm">
                    {patient.last_login_date ? (
                      <div>
                        <div>{format(new Date(patient.last_login_date), 'MMM d, yyyy')}</div>
                        <div className="text-xs text-slate-400">{patient.portal_login_count ?? 0} login{(patient.portal_login_count ?? 0) !== 1 ? 's' : ''}</div>
                      </div>
                    ) : (
                      <span className="text-slate-400">Never</span>
                    )}
                  </td>
                  <td className="p-3">
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="ghost" onClick={() => onEdit(patient)}>
                        Edit
                      </Button>
                      <Button 
                        size="sm" 
                        variant="ghost" 
                        onClick={() => onDelete(patient.id)}
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