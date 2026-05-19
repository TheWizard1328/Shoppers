import React, { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { MultiSelect } from '@/components/ui/multi-select';
import { base44 } from '@/api/base44Client';
import { Copy, Download } from 'lucide-react';
import { userHasRole } from '@/components/utils/userRoles';
import { toast } from 'sonner';

export default function InviteQRCodeModal({ isOpen, onClose, currentUser, stores = [] }) {
  const [selectedRole, setSelectedRole] = useState('driver');
  const [selectedStores, setSelectedStores] = useState([]);
  const [qrUrl, setQrUrl] = useState(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [inviteUrl, setInviteUrl] = useState(null);

  // Determine available roles and stores based on user role
  const isAdmin = userHasRole(currentUser, 'admin');
  const isDispatcher = userHasRole(currentUser, 'dispatcher');
  const isDriver = userHasRole(currentUser, 'driver');

  // Set initial role based on user type
  useEffect(() => {
    if (isDispatcher && !isAdmin) {
      setSelectedRole('dispatcher');
      // Set to dispatcher's own stores
      setSelectedStores(currentUser.store_ids || []);
    } else if (isDriver && !isAdmin && !isDispatcher) {
      setSelectedRole('driver');
      // Set to driver's own stores if they have any
      const driverStores = currentUser.store_ids || [];
      setSelectedStores(driverStores);
    } else {
      setSelectedRole('driver');
      setSelectedStores([]);
    }
  }, [isOpen]);

  // Build store options - for drivers, expand stores with AM/PM slots
  const buildStoreOptions = (role) => {
    if (role !== 'driver') {
      // Dispatchers and others: simple store list
      return stores.map((store) => ({
        value: store.id,
        label: store.name
      }));
    }

    // Drivers: expand stores that have multiple time slots into AM/PM entries
    const options = [];
    stores.forEach((store) => {
      const hasAM = store.weekday_am_enabled || store.saturday_am_enabled || store.sunday_am_enabled;
      const hasPM = store.weekday_pm_enabled || store.saturday_pm_enabled || store.sunday_pm_enabled;

      if (hasAM && hasPM) {
        options.push({ value: `${store.id}__AM`, label: `${store.name} [AM]` });
        options.push({ value: `${store.id}__PM`, label: `${store.name} [PM]` });
      } else if (hasAM) {
        options.push({ value: store.id, label: `${store.name} [AM]` });
      } else if (hasPM) {
        options.push({ value: store.id, label: `${store.name} [PM]` });
      } else {
        options.push({ value: store.id, label: store.name });
      }
    });
    return options;
  };

  // Strip the __AM/__PM suffix to get actual store IDs for submission
  const getStoreIds = (selectedValues) => {
    return [...new Set(selectedValues.map((v) => v.replace(/__AM$|__PM$/, '')))];
  };

  const handleRoleChange = (role) => {
    setSelectedRole(role);
    setSelectedStores([]);
  };

  const availableRoles = isAdmin ? 
    ['admin', 'dispatcher', 'driver', 'patient'] : 
    isDispatcher ? 
      ['dispatcher', 'driver', 'patient'] : 
      ['driver', 'dispatcher', 'patient'];

  const handleGenerateQR = async () => {
    if (!selectedRole) {
      toast.error('Please select a role');
      return;
    }

    // For dispatcher/driver, require at least one store
    if ((selectedRole === 'dispatcher' || selectedRole === 'driver') && selectedStores.length === 0) {
      toast.error('Please select at least one store');
      return;
    }

    setIsGenerating(true);
    try {
      const response = await base44.functions.invoke('generateInviteQRCode', {
        role: selectedRole,
        store_ids: getStoreIds(selectedStores),
        app_origin: window.location.origin
      });

      if (response.data?.success || response.success) {
        const url = response.data?.inviteUrl || response.inviteUrl;
        setInviteUrl(url);
        setQrUrl(url);
        toast.success('QR code generated successfully');
      } else {
        toast.error('Failed to generate QR code');
      }
    } catch (error) {
      console.error('Error generating QR code:', error);
      toast.error('Failed to generate QR code');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleCopyURL = () => {
    if (inviteUrl) {
      navigator.clipboard.writeText(inviteUrl);
      toast.success('URL copied to clipboard');
    }
  };

  const handleDownloadQR = () => {
    const qrCanvas = document.querySelector('canvas');
    if (qrCanvas) {
      const link = document.createElement('a');
      link.href = qrCanvas.toDataURL('image/png');
      link.download = 'invite-qr-code.png';
      link.click();
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="w-full max-w-md">
        <DialogHeader>
          <DialogTitle>Generate Invite QR Code</DialogTitle>
        </DialogHeader>

        {!qrUrl ? (
          <div className="space-y-4">
            {/* Role Selection */}
            <div>
              <label className="text-sm font-medium mb-2 block">Role</label>
              <Select value={selectedRole} onValueChange={handleRoleChange}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a role" />
                </SelectTrigger>
                <SelectContent className="z-[10010]">
                  {availableRoles.map((role) => (
                    <SelectItem key={role} value={role}>
                      {role.charAt(0).toUpperCase() + role.slice(1)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Store Selection */}
            {(selectedRole === 'driver' || selectedRole === 'dispatcher') && (
              <div>
                <label className="text-sm font-medium mb-2 block">
                  Assign Stores {isDispatcher && !isAdmin ? '(Your Stores)' : ''}
                </label>
                {isDispatcher && !isAdmin ? (
                  <div className="space-y-2">
                    {stores
                      .filter((s) => currentUser.store_ids?.includes(s.id))
                      .map((store) => (
                        <div key={store.id} className="text-sm p-2 bg-slate-50 rounded">
                          {store.name}
                        </div>
                      ))}
                  </div>
                ) : (
                  <MultiSelect
                    options={buildStoreOptions(selectedRole)}
                    value={selectedStores}
                    onChange={setSelectedStores}
                    placeholder="Select stores"
                  />
                )}
              </div>
            )}

            <Button
              onClick={handleGenerateQR}
              disabled={isGenerating}
              className="w-full bg-emerald-600 hover:bg-emerald-700"
            >
              {isGenerating ? 'Generating...' : 'Generate QR Code'}
            </Button>
          </div>
        ) : (
          <div className="space-y-4 flex flex-col items-center">
            <div className="p-4 bg-white rounded-lg border">
              <img 
                src={`https://api.qrserver.com/v1/create-qr-code/?size=256x256&data=${encodeURIComponent(qrUrl)}`}
                alt="Invite QR Code"
                className="w-64 h-64"
              />
            </div>

            <p className="text-xs text-slate-500 text-center">
              Role: <span className="font-semibold">{selectedRole}</span>
            </p>

            <div className="space-y-2 w-full">
              <Button
                onClick={handleCopyURL}
                variant="outline"
                className="w-full gap-2"
              >
                <Copy className="w-4 h-4" />
                Copy URL
              </Button>
              <Button
                onClick={() => {
                  const link = document.createElement('a');
                  link.href = `https://api.qrserver.com/v1/create-qr-code/?size=512x512&data=${encodeURIComponent(qrUrl)}`;
                  link.download = 'invite-qr-code.png';
                  link.click();
                }}
                variant="outline"
                className="w-full gap-2"
              >
                <Download className="w-4 h-4" />
                Download QR Code
              </Button>
              <Button
                onClick={() => {
                  setQrUrl(null);
                  setInviteUrl(null);
                }}
                className="w-full bg-slate-200 text-slate-900 hover:bg-slate-300"
              >
                Generate Another
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}