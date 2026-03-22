import React from 'react';
import { AlertTriangle, Trash2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { toast } from 'sonner';
import { base44 } from '@/api/base44Client';
import { deleteMyAccount } from '@/functions/deleteMyAccount';

export default function AccountDeletionSection() {
  const [open, setOpen] = React.useState(false);
  const [isDeleting, setIsDeleting] = React.useState(false);
  const [confirmationText, setConfirmationText] = React.useState('');
  const canDelete = confirmationText.trim().toUpperCase() === 'DELETE' && !isDeleting;

  const handleDeleteAccount = async () => {
    setIsDeleting(true);
    try {
      const response = await deleteMyAccount({ confirmDeletion: true });
      const data = response?.data || response;

      if (!data?.success) {
        throw new Error(data?.error || 'Failed to delete account');
      }

      toast.success('Your account was deleted.');
      setOpen(false);
      setTimeout(() => {
        base44.auth.logout('/');
      }, 300);
    } catch (error) {
      toast.error(error?.response?.data?.error || error?.message || 'Failed to delete account');
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <>
      <Card className="border-2" style={{ background: 'var(--bg-white)', borderColor: '#fca5a5' }}>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold flex items-center gap-2 text-red-600">
            <AlertTriangle className="w-4 h-4" />
            Delete My Account
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <p className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>
              Permanently delete your account and associated personal data.
            </p>
            <ul className="list-disc pl-5 space-y-2 text-sm" style={{ color: 'var(--text-slate-600)' }}>
              <li>Your signed-in access will be removed.</li>
              <li>Your saved device settings and personal app data will be deleted.</li>
              <li>This action cannot be undone later.</li>
            </ul>
          </div>
          <Button onClick={() => setOpen(true)} variant="destructive" className="w-full gap-2 select-none">
            <Trash2 className="w-4 h-4" />
            Delete My Account
          </Button>
        </CardContent>
      </Card>

      <AlertDialog open={open} onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) {
          setConfirmationText('');
        }
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete My Account</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-4 text-sm" style={{ color: 'var(--text-slate-600)' }}>
                <p>
                  This will permanently remove your account from this app and immediately sign you out.
                </p>
                <ul className="list-disc pl-5 space-y-2">
                  <li>App profile and connected device records</li>
                  <li>Saved device and user settings</li>
                  <li>Your personal messaging history in this app</li>
                </ul>
                <div className="space-y-2">
                  <p className="font-medium" style={{ color: 'var(--text-slate-900)' }}>
                    Type DELETE to confirm.
                  </p>
                  <Input
                    value={confirmationText}
                    onChange={(event) => setConfirmationText(event.target.value)}
                    placeholder="Type DELETE"
                    autoComplete="off"
                  />
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                if (!canDelete) return;
                handleDeleteAccount();
              }}
              disabled={!canDelete}
              className="bg-red-600 hover:bg-red-700"
            >
              {isDeleting ? 'Deleting...' : 'Delete Account'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}