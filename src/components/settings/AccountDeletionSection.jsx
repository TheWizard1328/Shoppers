import React from 'react';
import { AlertTriangle, Trash2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
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
          <CardTitle className="text-sm font-semibold flex items-center gap-2 text-red-600">
            <AlertTriangle className="w-4 h-4" />
            Danger Zone
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm mb-3" style={{ color: 'var(--text-slate-600)' }}>
            Permanently delete your account and sign out of the app. This action cannot be undone.
          </p>
          <Button onClick={() => setOpen(true)} variant="destructive" className="w-full gap-2 select-none">
            <Trash2 className="w-4 h-4" />
            Delete Account
          </Button>
        </CardContent>
      </Card>

      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete account permanently?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes your account, device settings, and related personal app data. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteAccount}
              disabled={isDeleting}
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