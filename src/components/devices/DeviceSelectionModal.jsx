import React, { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Smartphone, Tablet, Monitor } from 'lucide-react';

export default function DeviceSelectionModal({
  isOpen,
  deviceType,
  onDeviceSelected,
  isLoading = false
}) {
  const [deviceName, setDeviceName] = useState('');
  const [selectedType, setSelectedType] = useState(deviceType);

  const handleConfirm = async () => {
    if (!deviceName.trim()) {
      alert('Please enter a device name');
      return;
    }

    onDeviceSelected({
      device_name: deviceName,
      device_type: selectedType,
      device_info: {
        device_type: selectedType
      }
    });
  };

  const getDeviceIcon = (type) => {
    switch (type) {
      case 'Mobile': return <Smartphone className="w-8 h-8" />;
      case 'Tablet': return <Tablet className="w-8 h-8" />;
      case 'Desktop': return <Monitor className="w-8 h-8" />;
      default: return <Smartphone className="w-8 h-8" />;
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={() => {}}>
      <DialogContent className="sm:max-w-md" onPointerDownOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>Set Up Your Device</DialogTitle>
          <DialogDescription>
            Create a profile for this device to personalize your experience
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {/* Device Type Display */}
          <div>
            <label className="block text-sm font-medium mb-3">Detected Device Type</label>
            <div className="flex items-center gap-3 p-4 rounded-lg border" style={{ borderColor: 'var(--border-slate-200)', background: 'var(--bg-slate-50)' }}>
              <div className="text-slate-600">
                {getDeviceIcon(selectedType)}
              </div>
              <div>
                <p className="font-semibold" style={{ color: 'var(--text-slate-900)' }}>{selectedType}</p>
                <p className="text-sm" style={{ color: 'var(--text-slate-500)' }}>
                  {selectedType === 'Mobile' && 'Phone or mobile device'}
                  {selectedType === 'Tablet' && 'Tablet device'}
                  {selectedType === 'Desktop' && 'Desktop or laptop computer'}
                </p>
              </div>
            </div>
          </div>

          {/* Device Name Input */}
          <div>
            <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-slate-900)' }}>
              Device Name
            </label>
            <Input
              placeholder={`My ${selectedType}`}
              value={deviceName}
              onChange={(e) => setDeviceName(e.target.value)}
              disabled={isLoading}
              onKeyPress={(e) => {
                if (e.key === 'Enter' && !isLoading) {
                  handleConfirm();
                }
              }}
              className="w-full"
            />
            <p className="text-xs mt-2" style={{ color: 'var(--text-slate-500)' }}>
              Give this device a memorable name (e.g., "Work iPhone", "Home Tablet")
            </p>
          </div>

          {/* Info Box */}
          <div className="p-4 rounded-lg" style={{ background: 'var(--bg-slate-100)' }}>
            <p className="text-sm" style={{ color: 'var(--text-slate-700)' }}>
              <strong>Note:</strong> Device-specific settings (like map view preferences and sidebar width) will be saved to this device only. Global settings (like notifications) sync across all your devices.
            </p>
          </div>

          {/* Action Buttons */}
          <div className="flex gap-3">
            <Button
              onClick={handleConfirm}
              disabled={!deviceName.trim() || isLoading}
              className="flex-1 bg-emerald-600 hover:bg-emerald-700">
              {isLoading ? 'Setting up...' : 'Continue'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}