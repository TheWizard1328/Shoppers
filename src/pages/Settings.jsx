import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { base44 } from '@/api/base44Client';
import { 
  User, 
  Bell, 
  Moon, 
  Smartphone, 
  Trash2, 
  AlertTriangle,
  LogOut,
  ChevronRight
} from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from 'sonner';
import { useUser } from '@/components/utils/UserContext';

export default function Settings() {
  const { currentUser } = useUser();
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const handleDeleteAccount = async () => {
    if (!currentUser) return;

    setIsDeleting(true);
    try {
      // Send account deletion request email to admin
      await base44.integrations.Core.SendEmail({
        to: 'admin@rxdeliver.com', // Replace with actual admin email
        subject: `Account Deletion Request - ${currentUser.full_name || currentUser.user_name}`,
        body: `
User ${currentUser.full_name || currentUser.user_name} (${currentUser.email || currentUser.id}) 
has requested account deletion.

User ID: ${currentUser.id}
Requested at: ${new Date().toISOString()}

Please review and process this request.
        `.trim()
      });

      toast.success('Account deletion requested. An administrator will contact you.');
      setShowDeleteDialog(false);
      
      // Log out after request
      setTimeout(() => {
        base44.auth.logout();
      }, 2000);
    } catch (error) {
      console.error('Failed to request account deletion:', error);
      toast.error('Failed to submit deletion request. Please try again.');
    } finally {
      setIsDeleting(false);
    }
  };

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
          onClick: () => window.location.href = createPageUrl('DeviceSettings')
        }
      ]
    }
  ];

  return (
    <div className="h-full overflow-y-auto pb-20" style={{ background: 'var(--bg-slate-50)' }}>
      <div className="max-w-2xl mx-auto p-4 space-y-4">
        <div className="mb-6">
          <h1 className="text-2xl font-bold mb-1" style={{ color: 'var(--text-slate-900)' }}>
            Settings
          </h1>
          <p className="text-sm" style={{ color: 'var(--text-slate-500)' }}>
            Manage your account and preferences
          </p>
        </div>

        {settingsSections.map((section) => {
          const SectionIcon = section.icon;
          return (
            <Card key={section.title} style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold flex items-center gap-2" style={{ color: 'var(--text-slate-700)' }}>
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
                        <p className="text-xs truncate" style={{ color: 'var(--text-slate-500)' }}>
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

        {/* Delete Account Section */}
        <Card 
          className="border-2" 
          style={{ 
            background: 'var(--bg-white)', 
            borderColor: '#fca5a5' 
          }}
        >
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold flex items-center gap-2 text-red-600">
              <AlertTriangle className="w-4 h-4" />
              Danger Zone
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm mb-3" style={{ color: 'var(--text-slate-600)' }}>
              Once you delete your account, there is no going back. This action will notify an administrator to review your request.
            </p>
            <Button
              onClick={() => setShowDeleteDialog(true)}
              variant="destructive"
              className="w-full gap-2 select-none"
            >
              <Trash2 className="w-4 h-4" />
              Request Account Deletion
            </Button>
          </CardContent>
        </Card>

        {/* Delete Confirmation Dialog */}
        <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete Account?</AlertDialogTitle>
              <AlertDialogDescription>
                This will send a deletion request to the administrator. Your account will remain active until the request is reviewed and processed. Are you sure you want to proceed?
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={handleDeleteAccount}
                disabled={isDeleting}
                className="bg-red-600 hover:bg-red-700"
              >
                {isDeleting ? 'Sending...' : 'Request Deletion'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}