import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { base44 } from '@/api/base44Client';
import { createPageUrl } from '@/utils';
import {
  User,
  Bell,
  Moon,
  Smartphone,
  LogOut,
  ChevronRight,
} from 'lucide-react';
import { toast } from 'sonner';
import { useUser } from '@/components/utils/UserContext';
import AccountDeletionSection from '@/components/settings/AccountDeletionSection';

export default function Settings() {
  const { currentUser } = useUser();
  const navigate = useNavigate();

  const settingsSections = [
    {
      title: 'Account',
      icon: User,
      items: [
        {
          label: 'Profile',
          description: currentUser?.full_name || currentUser?.user_name || 'User',
          onClick: () => toast.info('Profile settings coming soon')
        },
        {
          label: 'Email',
          description: currentUser?.email || 'Not available',
          disabled: true
        }
      ]
    },
    {
      title: 'Notifications',
      icon: Bell,
      items: [
        {
          label: 'Push Notifications',
          description: 'Manage notification preferences',
          onClick: () => toast.info('Notification settings coming soon')
        }
      ]
    },
    {
      title: 'Appearance',
      icon: Moon,
      items: [
        {
          label: 'Theme',
          description: 'Light, Dark, or Auto',
          onClick: () => toast.info('Theme settings available in sidebar')
        }
      ]
    },
    {
      title: 'Devices',
      icon: Smartphone,
      items: [
        {
          label: 'Manage Devices',
          description: 'View and manage connected devices',
          onClick: () => navigate(createPageUrl('DeviceSettings'))
        }
      ]
    }
  ];

  return (
    <div className="h-full overflow-y-auto pb-20" style={{ background: 'var(--bg-slate-50)' }}>
      <div className="max-w-2xl mx-auto p-4 space-y-4">
        <div className="mb-6 space-y-3">
          <div>
            <h1 className="text-2xl font-bold mb-1" style={{ color: 'var(--text-slate-900)' }}>
              Settings
            </h1>
            <p className="text-sm" style={{ color: 'var(--text-slate-500)' }}>
              Manage your account, devices, and privacy preferences.
            </p>
          </div>

          <Card style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
            <CardContent className="p-4">
              <p className="text-sm leading-6" style={{ color: 'var(--text-slate-600)' }}>
                You can permanently delete your account and associated personal data below using the Delete My Account option.
              </p>
            </CardContent>
          </Card>
        </div>

        {settingsSections.map((section) => {
          const SectionIcon = section.icon;
          return (
            <Card key={section.title} style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
              <CardHeader className="pb-3">
                <CardTitle className="text-base font-semibold flex items-center gap-2" style={{ color: 'var(--text-slate-700)' }}>
                  <SectionIcon className="w-4 h-4" />
                  {section.title}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-1">
                {section.items.map((item, index) => (
                  <button
                    key={index}
                    onClick={item.onClick}
                    disabled={item.disabled}
                    className={`w-full flex items-center justify-between px-3 py-3 rounded-lg transition-colors text-left select-none ${
                      item.disabled 
                        ? 'opacity-50 cursor-not-allowed' 
                        : 'hover:bg-slate-50 active:bg-slate-100'
                    }`}
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>
                        {item.label}
                      </p>
                      {item.description && (
                        <p className="text-sm truncate" style={{ color: 'var(--text-slate-500)' }}>
                          {item.description}
                        </p>
                      )}
                    </div>
                    {!item.disabled && (
                      <ChevronRight className="w-4 h-4 text-slate-400 flex-shrink-0 ml-2" />
                    )}
                  </button>
                ))}
              </CardContent>
            </Card>
          );
        })}

        {/* Logout Button */}
        <Card style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
          <CardContent className="p-4">
            <Button
              onClick={() => base44.auth.logout()}
              variant="outline"
              className="w-full justify-start gap-2 select-none"
            >
              <LogOut className="w-4 h-4" />
              Sign Out
            </Button>
          </CardContent>
        </Card>

        <AccountDeletionSection />
      </div>
    </div>
  );
}