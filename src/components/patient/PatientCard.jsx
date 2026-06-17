import React, { useState } from "react";
import { motion } from "framer-motion";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { User, Phone, MapPin, Package, Edit, Calendar, Clock, Building, FileText, Save, UserPlus } from "lucide-react";
import { format } from "date-fns";
import { Patient } from "@/entities/Patient";

export default function PatientCard({ patient, deliveries, onSelect, onEdit, selected, deliveryStats, distanceFromStore, storeInfo, onAddToRoute }) {
  const [isEditingNotes, setIsEditingNotes] = useState(false);
  const [notes, setNotes] = useState(patient.notes || "");
  const [isSaving, setIsSaving] = useState(false);

  const activeDeliveries = deliveries.filter(d =>
    ['pending', 'in_transit'].includes(d.status)
  ).length;

  const handleSaveNotes = async () => {
    setIsSaving(true);
    try {
      await Patient.update(patient.id, { notes });
      setIsEditingNotes(false);
      // Update the patient object to reflect the change
      patient.notes = notes;
    } catch (error) {
      console.error("Error saving notes:", error);
      alert("Failed to save notes");
    }
    setIsSaving(false);
  };

  const handlePhoneClick = (phone) => {
    if (phone) {
      window.location.href = `tel:${phone}`;
    }
  };

  const handleAddressClick = (address) => {
    if (address) {
      // This format is more universally recognized across devices
      window.open(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`, '_blank');
    }
  };

  // Calculate day-of-week breakdown
  const dayBreakdown = { M: 0, T: 0, W: 0, T2: 0, F: 0, S: 0, S2: 0 };
  const dayNames = ['S2', 'M', 'T', 'W', 'T2', 'F', 'S']; // Sunday = 0, Monday = 1, etc.

  deliveries.forEach(delivery => {
    const deliveryDate = new Date(delivery.delivery_date);
    if (!isNaN(deliveryDate)) {
      const dayIndex = deliveryDate.getDay();
      const dayKey = dayNames[dayIndex];
      dayBreakdown[dayKey]++;
    }
  });

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
      whileHover={{ y: -2 }}
      transition={{ duration: 0.2 }}
    >
      <Card
        className={`cursor-pointer transition-all duration-200 ${
          selected
            ? 'border-emerald-500 bg-emerald-50 shadow-md'
            : 'border-slate-200 bg-white hover:border-slate-300 hover:shadow-sm'
        }`}
        onClick={() => onSelect(patient)}
      >
        <CardContent className="p-6">
          {/* Header Section */}
          <div className="flex items-start justify-between mb-4">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 bg-gradient-to-br from-slate-100 to-slate-200 rounded-xl flex items-center justify-center">
                <User className="w-6 h-6 text-slate-600" />
              </div>
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <h3 className="font-semibold text-slate-900">
                    {patient.full_name}
                  </h3>
                  {deliveryStats?.lastDeliveryDate && (
                    <Badge variant="outline" className="text-xs bg-blue-50 text-blue-700 border-blue-200">
                      Last: {(() => {
                        try {
                          const date = new Date(deliveryStats.lastDeliveryDate.replace(/-/g, '/'));
                          if (!isNaN(date.getTime())) {
                            return format(date, 'MMM d, yy');
                          }
                          return 'Invalid';
                        } catch (error) {
                          return 'Invalid';
                        }
                      })()}
                    </Badge>
                  )}
                </div>
                <p
                  className="text-sm text-slate-600 cursor-pointer underline hover:text-blue-600"
                  onClick={(e) => {
                    e.stopPropagation();
                    handlePhoneClick(patient.phone);
                  }}
                >
                  {patient.phone || 'No phone'}
                </p>
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                onEdit(patient);
              }}
              className="hover:bg-slate-100"
            >
              <Edit className="w-4 h-4" />
            </Button>
          </div>

          {/* Main Content Grid */}
          <div className="grid md:grid-cols-2 gap-4 mb-4">
            {/* Left Column - Main Info */}
            <div className="space-y-3">
              {patient.address && (
                <div className="flex items-start gap-2 text-sm text-slate-600">
                  <MapPin className="w-4 h-4 mt-0.5" />
                  <span
                    className="leading-relaxed cursor-pointer underline hover:text-blue-600"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleAddressClick(patient.address);
                    }}
                  >
                    {patient.address}
                  </span>
                </div>
              )}

              {storeInfo && (
                <div className="flex items-center gap-2 text-sm text-purple-600">
                  <Building className="w-4 h-4" />
                  <span className="truncate">{storeInfo.name}</span>
                </div>
              )}

              {distanceFromStore && (
                <div className="flex items-center gap-2 text-sm text-emerald-600 font-medium">
                  <MapPin className="w-4 h-4" />
                  <span>{distanceFromStore.toFixed(1)} km from store</span>
                </div>
              )}

            </div>

            {/* Right Column - Notes */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <FileText className="w-4 h-4 text-slate-500" />
                  <span className="font-medium text-slate-900 text-sm">Notes</span>
                </div>
                {!isEditingNotes && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      setIsEditingNotes(true);
                    }}
                    className="text-xs hover:bg-slate-100"
                  >
                    <Edit className="w-3 h-3" />
                  </Button>
                )}
              </div>

              {isEditingNotes ? (
                <div className="space-y-2" onClick={(e) => e.stopPropagation()}>
                  <Textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Add patient notes..."
                    className="h-20 text-sm border-black"
                  />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      onClick={handleSaveNotes}
                      disabled={isSaving}
                      className="text-xs bg-emerald-600 hover:bg-emerald-700"
                    >
                      <Save className="w-3 h-3 mr-1" />
                      {isSaving ? 'Saving...' : 'Save'}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setIsEditingNotes(false);
                        setNotes(patient.notes || "");
                      }}
                      className="text-xs border-black"
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="text-slate-600 text-sm leading-relaxed min-h-[60px]">
                  {patient.notes || 'No notes added'}
                </p>
              )}
            </div>
          </div>

          {selected && (
            <div className="flex justify-end mb-4 -mt-2">
                <Button
                    onClick={(e) => {
                        e.stopPropagation();
                        onAddToRoute(patient);
                    }}
                    className="bg-blue-600 hover:bg-blue-700 h-9"
                    size="sm"
                >
                    <UserPlus className="w-4 h-4 mr-2" />
                    Add To Route
                </Button>
            </div>
          )}

          {/* Footer Stats */}
          <div className="flex items-center justify-between pt-3 border-t border-slate-100">
            <div className="flex items-center gap-4 text-sm flex-wrap">
              <div className="flex items-center gap-1">
                <Package className="w-4 h-4 text-emerald-600" />
                <span className="text-slate-600">{deliveryStats?.totalDeliveries || 0} total</span>
              </div>
              {activeDeliveries > 0 && (
                <Badge className="bg-blue-100 text-blue-800">
                  {activeDeliveries} active
                </Badge>
              )}
              {/* Day breakdown */}
              <div className="flex items-center gap-1 text-xs text-slate-500">
                <span>M:{dayBreakdown.M}</span>
                <span>T:{dayBreakdown.T}</span>
                <span>W:{dayBreakdown.W}</span>
                <span>T:{dayBreakdown.T2}</span>
                <span>F:{dayBreakdown.F}</span>
                <span>S:{dayBreakdown.S}</span>
                <span>S:{dayBreakdown.S2}</span>
              </div>
              {/* Time Windows */}
              {(patient.time_window_start || patient.time_window_end) && (
                <div className="flex items-center gap-1 text-xs text-blue-600 font-medium">
                  <Clock className="w-3 h-3" />
                  <span>
                    {patient.time_window_start && patient.time_window_end
                      ? `${patient.time_window_start}-${patient.time_window_end}`
                      : patient.time_window_start
                        ? `After ${patient.time_window_start}`
                        : `Before ${patient.time_window_end}`
                    }
                  </span>
                </div>
              )}
            </div>

            {/* Patient ID in bottom right */}
            <p className="text-xs text-slate-500 font-mono">
              ID: {patient.patient_id}
            </p>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}