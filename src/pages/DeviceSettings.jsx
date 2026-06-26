import React from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import { useUser } from '../components/utils/UserContext';
import DevicesPanel from '../components/devices/DevicesPanel';

export default function DeviceSettings() {
  const navigate = useNavigate();
  const { currentUser } = useUser();

  return (
    <div className="h-full overflow-y-auto pb-20" style={{ background: 'var(--bg-slate-50)' }}>
      <div className="max-w-2xl mx-auto p-4 space-y-4">
        <div>
          <button
            onClick={() => navigate(-1)}
            className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800 mb-3"
          >
            <ChevronLeft className="w-4 h-4" /> Back
          </button>
          <div>
            <h1 className="text-2xl font-bold" style={{ color: 'var(--text-slate-900)' }}>Devices</h1>
            <p className="text-sm mt-0.5" style={{ color: 'var(--text-slate-500)' }}>
              Manage your registered devices and location tracking.
            </p>
          </div>
        </div>

        {currentUser && <DevicesPanel currentUser={currentUser} />}
      </div>
    </div>
  );
}