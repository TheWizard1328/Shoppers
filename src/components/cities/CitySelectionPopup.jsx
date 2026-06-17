import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { MapPin, AlertCircle, Loader2 } from 'lucide-react';
import { base44 } from "@/api/base44Client";

export default function CitySelectionPopup({ cities, currentUser, onCitySelected }) {
  const [selectedCityId, setSelectedCityId] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState(null);

  const handleSave = async () => {
    if (!selectedCityId) {
      setError('Please select a city to continue');
      return;
    }

    setIsSaving(true);
    setError(null);

    try {
      console.log('🏙️ [CitySelectionPopup] Saving city selection:', selectedCityId);

      // Find the user's AppUser record
      const appUsers = await base44.entities.AppUser.list();
      const userAppUser = appUsers.find(au => au.user_id === currentUser.id);

      if (userAppUser) {
        // Update existing AppUser record
        await base44.entities.AppUser.update(userAppUser.id, {
          city_id: selectedCityId
        });
        console.log('✅ [CitySelectionPopup] Updated existing AppUser record');
      } else {
        // Create new AppUser record (edge case)
        await base44.entities.AppUser.create({
          user_id: currentUser.id,
          user_name: currentUser.full_name,
          city_id: selectedCityId,
          app_roles: ['driver'], // Default role
          status: 'active'
        });
        console.log('✅ [CitySelectionPopup] Created new AppUser record');
      }

      // Call the callback to update global filters and close popup
      onCitySelected(selectedCityId);
    } catch (err) {
      console.error('❌ [CitySelectionPopup] Error saving city:', err);
      setError('Failed to save city selection. Please try again.');
      setIsSaving(false);
    }
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9999] p-4"
        style={{ backdropFilter: 'blur(4px)' }}
      >
        <motion.div
          initial={{ scale: 0.9, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.9, opacity: 0 }}
          className="w-full max-w-md"
        >
          <Card className="border-2 border-emerald-500 shadow-2xl" style={{ background: 'var(--bg-white)', borderColor: '#10b981' }}>
            <CardHeader className="text-center space-y-2 pb-4">
              <div className="mx-auto w-12 h-12 bg-emerald-100 dark:bg-emerald-900/40 rounded-full flex items-center justify-center mb-2">
                <MapPin className="w-6 h-6 text-emerald-600 dark:text-emerald-400" />
              </div>
              <CardTitle className="text-2xl" style={{ color: 'var(--text-slate-900)' }}>Welcome to RxDeliver</CardTitle>
              <CardDescription className="text-base" style={{ color: 'var(--text-slate-500)' }}>
                Please select your city to continue
              </CardDescription>
            </CardHeader>

            <CardContent className="space-y-4">
              {error && (
                <div className="flex items-center gap-2 p-3 rounded-lg text-sm" style={{ background: 'var(--bg-red-50, #fef2f2)', border: '1px solid var(--border-red-200, #fecaca)', color: '#b91c1c' }}>
                  <AlertCircle className="w-4 h-4 flex-shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              <div className="space-y-2">
                <label className="text-sm font-medium" style={{ color: 'var(--text-slate-700)' }}>
                  Select Your City *
                </label>
                <div className="grid grid-cols-1 gap-2 max-h-[300px] overflow-y-auto p-1">
                  {cities.map((city) => (
                    <button
                      key={city.id}
                      onClick={() => {
                        setSelectedCityId(city.id);
                        setError(null);
                      }}
                      disabled={isSaving}
                      className={`p-4 rounded-lg border-2 text-left transition-all ${isSaving ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                      style={selectedCityId === city.id
                        ? { borderColor: '#10b981', background: 'var(--bg-emerald-50, rgba(16,185,129,0.1))', boxShadow: '0 2px 8px rgba(0,0,0,0.15)' }
                        : { borderColor: 'var(--border-slate-200)', background: 'var(--bg-white)' }
                      }
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <h3 className="font-semibold" style={{ color: 'var(--text-slate-900)' }}>{city.name}</h3>
                          <p className="text-sm" style={{ color: 'var(--text-slate-600)' }}>
                            {city.province_state}, {city.country}
                          </p>
                        </div>
                        {selectedCityId === city.id && (
                          <div className="w-6 h-6 bg-emerald-500 rounded-full flex items-center justify-center">
                            <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                            </svg>
                          </div>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              <Button
                onClick={handleSave}
                disabled={!selectedCityId || isSaving}
                className="w-full bg-emerald-600 hover:bg-emerald-700 h-11"
              >
                {isSaving ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Saving...
                  </>
                ) : (
                  'Continue'
                )}
              </Button>

              <p className="text-xs text-center" style={{ color: 'var(--text-slate-500)' }}>
                This will be saved to your profile
              </p>
            </CardContent>
          </Card>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}