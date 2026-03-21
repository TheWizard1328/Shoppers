import React from 'react';
import { Trash2 } from 'lucide-react';
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
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

export default function DeleteAccountMenuItem() {
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
      <DropdownMenuSeparator style={{ background: 'var(--border-slate-200)' }} />
      <DropdownMenuItem
        onSelect={(event) => {
          event.preventDefault();
          setOpen(true);
        }}
        className="cursor-pointer text-red-600"
      >
        <Trash2 className="w-4 h-4 mr-2" />
        Delete Account
      </DropdownMenuItem>

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