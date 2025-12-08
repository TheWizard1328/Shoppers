import React from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Phone, MapPin, Percent, Building2 } from 'lucide-react';
import { formatPhoneNumber } from '../utils/phoneFormatter';

export default function PatientMatchPopup({ isOpen, onClose, matches, onSelectPatient, extractedData, stores }) {
  if (!matches || matches.length === 0) return null;

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto z-[10020]">
        <DialogHeader>
          <DialogTitle>Select Patient</DialogTitle>
          <DialogDescription>
            Multiple patients match the scanned prescription label. Please select the correct one.
          </DialogDescription>
        </DialogHeader>

        {extractedData && (
          <Card className="p-4 bg-slate-50 border-slate-200 mb-4">
            <h3 className="text-sm font-semibold text-slate-700 mb-2">Scanned Data:</h3>
            <div className="space-y-1 text-sm">
              <div><span className="font-medium">Name:</span> {extractedData.patient_name}</div>
              <div><span className="font-medium">Address:</span> {extractedData.street_address}</div>
              {extractedData.city_state_zip && (
                <div><span className="font-medium">City/Postal:</span> {extractedData.city_state_zip}</div>
              )}
              <div><span className="font-medium">Phone:</span> {extractedData.phone_number}</div>
            </div>
          </Card>
        )}

        <div className="space-y-3">
          {matches.map((match, index) => (
            <Card 
              key={match.patient.id}
              className="p-4 hover:bg-slate-50 cursor-pointer transition-all border-2 hover:border-slate-300"
              onClick={() => onSelectPatient(match.patient)}
            >
              <div className="flex items-start justify-between mb-3">
                <div className="flex-1">
                  <h3 className="font-semibold text-lg text-slate-900">
                    {match.patient.full_name}
                  </h3>
                  {match.patient.patient_id && (
                    <p className="text-sm text-slate-500">ID: {match.patient.patient_id}</p>
                  )}
                </div>
                <div className="flex flex-col gap-1.5 items-end">
                  <Badge 
                    variant="secondary" 
                    className={`flex items-center gap-1 ${
                      match.matchScore >= 90 ? 'bg-green-100 text-green-800' :
                      match.matchScore >= 75 ? 'bg-blue-100 text-blue-800' :
                      'bg-yellow-100 text-yellow-800'
                    }`}
                  >
                    <Percent className="w-3 h-3" />
                    {match.matchScore}% Match
                  </Badge>
                  {stores && match.patient.store_id && (() => {
                    const patientStore = stores.find(s => s && s.id === match.patient.store_id);
                    if (!patientStore) return null;
                    return (
                      <Badge variant="outline" className="flex items-center gap-1 text-xs">
                        <Building2 className="w-3 h-3" />
                        {patientStore.name}
                      </Badge>
                    );
                  })()}
                </div>
              </div>

              <div className="space-y-2 text-sm">
                <div className="flex items-start gap-2">
                  <MapPin className="w-4 h-4 text-slate-500 mt-0.5 flex-shrink-0" />
                  <div>
                    <div>{match.patient.address}</div>
                    {match.patient.unit_number && (
                      <div className="text-slate-600">Unit: {match.patient.unit_number}</div>
                    )}
                  </div>
                </div>

                {match.patient.phone && (
                  <div className="flex items-center gap-2">
                    <Phone className="w-4 h-4 text-slate-500" />
                    <a 
                      href={`tel:${match.patient.phone}`}
                      className="text-slate-700 hover:text-slate-900"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {formatPhoneNumber(match.patient.phone)}
                    </a>
                  </div>
                )}
              </div>

              <Button 
                className="w-full mt-3"
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectPatient(match.patient);
                }}
              >
                Select This Patient
              </Button>
            </Card>
          ))}
        </div>

        <div className="flex justify-end gap-2 mt-4 pt-4 border-t">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}