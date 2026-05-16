import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Search, Package } from "lucide-react";
import { getEffectiveUser } from "@/components/utils/auth";
import { userHasRole } from "@/components/utils/userRoles";
import { sortUsers } from "@/components/utils/sorting";
import { getDriverDisplayName } from "@/components/utils/driverUtils";

export default function DriversPage() {
  const [currentUser, setCurrentUser] = useState(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedCityId, setSelectedCityId] = useState("all");
  const [isLoading, setIsLoading] = useState(true);
  const isMounted = useRef(false);

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  const { data: appUsers = [] } = useQuery({
    queryKey: ["appUsers"],
    queryFn: () => base44.entities.AppUser.list(),
    initialData: [],
  });

  const { data: cities = [] } = useQuery({
    queryKey: ["cities"],
    queryFn: () => base44.entities.City.list(),
    initialData: [],
  });

  useEffect(() => {
    const checkAccess = async () => {
      try {
        const user = await getEffectiveUser();
        if (isMounted.current) {
          setCurrentUser(user);
          setIsLoading(false);
        }
      } catch (error) {
        console.error("Error checking access:", error);
        if (isMounted.current) {
          setIsLoading(false);
        }
      }
    };

    checkAccess();
  }, []);

  const filteredDrivers = useMemo(() => {
    if (!appUsers || appUsers.length === 0) return [];

    let filtered = appUsers.filter((user) => {
      if (!user) return false;
      const roles = Array.isArray(user.app_roles) ? user.app_roles : [];
      return roles.includes("driver") || roles.includes("admin");
    });

    // Filter by search term
    if (searchTerm) {
      const lowerSearch = searchTerm.toLowerCase();
      filtered = filtered.filter((driver) => {
        const name = (driver.user_name || driver.full_name || "").toLowerCase();
        const email = (driver.email || "").toLowerCase();
        return name.includes(lowerSearch) || email.includes(lowerSearch);
      });
    }

    // Filter by city if not admin
    if (!userHasRole(currentUser, "admin") && currentUser?.city_id) {
      filtered = filtered.filter((d) => d.city_id === currentUser.city_id);
    } else if (userHasRole(currentUser, "admin") && selectedCityId !== "all") {
      filtered = filtered.filter((d) => d.city_id === selectedCityId);
    }

    // Sort by sort_order then by name
    return sortUsers(filtered);
  }, [appUsers, searchTerm, selectedCityId, currentUser]);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-xl text-slate-700">
        <div className="text-center">
          <div className="animate-spin w-8 h-8 border-4 border-emerald-500 border-t-transparent rounded-full mx-auto mb-4"></div>
          <p>Loading drivers...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-slate-50 p-4 md:p-6">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-slate-900 mb-4">Drivers</h1>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-4">
          <div className="flex-1 relative max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <Input
              placeholder="Search by name or email..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-10 bg-white"
            />
          </div>

          {userHasRole(currentUser, "admin") && cities.length > 0 && (
            <Select value={selectedCityId} onValueChange={setSelectedCityId}>
              <SelectTrigger className="w-full sm:w-[200px]" style={{ background: "white" }}>
                <SelectValue placeholder="Select City" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Cities</SelectItem>
                {cities.map((city) => (
                  <SelectItem key={city.id} value={city.id}>
                    {city.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>

      {/* Driver Cards Grid */}
      {filteredDrivers.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <Package className="w-16 h-16 mx-auto mb-4 opacity-30 text-slate-400" />
            <p className="text-lg font-medium text-slate-700">No drivers found</p>
            <p className="text-sm text-slate-500 mt-2">
              {searchTerm
                ? "Try adjusting your search criteria"
                : "Add drivers to get started"}
            </p>
          </div>
        </div>
      ) : (
        <div
          className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 auto-rows-max"
          style={{ alignContent: "start" }}
        >
          {filteredDrivers.map((driver) => (
            <Card
              key={driver.id}
              className="bg-white rounded-xl border shadow hover:shadow-lg transition-shadow"
              style={{ borderColor: "var(--border-slate-200)" }}
            >
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center justify-between gap-2">
                  <span className="text-lg font-bold text-slate-900">
                    {getDriverDisplayName(driver)}
                  </span>
                  <Badge variant="outline" className="flex-shrink-0">
                    {driver.status === "active" ? "Active" : "Inactive"}
                  </Badge>
                </CardTitle>
              </CardHeader>

              <CardContent className="space-y-3">
                {/* Email */}
                {driver.email && (
                  <div className="space-y-1">
                    <p className="text-xs font-medium text-slate-500">Email</p>
                    <p className="text-sm text-slate-700 break-all">{driver.email}</p>
                  </div>
                )}

                {/* Phone */}
                {driver.phone && (
                  <div className="space-y-1">
                    <p className="text-xs font-medium text-slate-500">Phone</p>
                    <p className="text-sm text-slate-700">{driver.phone}</p>
                  </div>
                )}

                {/* Roles */}
                {driver.app_roles && driver.app_roles.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-xs font-medium text-slate-500">Roles</p>
                    <div className="flex flex-wrap gap-1">
                      {driver.app_roles.map((role) => (
                        <Badge
                          key={role}
                          variant="secondary"
                          className="text-xs capitalize"
                        >
                          {role}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}

                {/* City */}
                {driver.city_id && (
                  <div className="space-y-1">
                    <p className="text-xs font-medium text-slate-500">City</p>
                    <p className="text-sm text-slate-700">
                      {cities.find((c) => c.id === driver.city_id)?.name || driver.city_id}
                    </p>
                  </div>
                )}

                {/* Pay Rate */}
                {driver.pay_rate_per_delivery && (
                  <div className="space-y-1">
                    <p className="text-xs font-medium text-slate-500">Pay Rate</p>
                    <p className="text-sm font-medium text-emerald-600">
                      ${driver.pay_rate_per_delivery.toFixed(2)}/delivery
                    </p>
                  </div>
                )}

                {/* Travel Mode */}
                {driver.preferred_travel_mode && (
                  <div className="space-y-1">
                    <p className="text-xs font-medium text-slate-500">Travel Mode</p>
                    <p className="text-sm text-slate-700 capitalize">
                      {driver.preferred_travel_mode}
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}