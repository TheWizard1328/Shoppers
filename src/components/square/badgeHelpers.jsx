import React from 'react';
import { Badge } from '@/components/ui/badge';
import { CheckCircle, XCircle, Clock, RefreshCw } from 'lucide-react';

export const getStatusBadge = (status) => {
  const config = {
    pending: { color: 'bg-amber-100 text-amber-800', icon: Clock },
    completed: { color: 'bg-green-100 text-green-800', icon: CheckCircle },
    failed: { color: 'bg-red-100 text-red-800', icon: XCircle },
    cancelled: { color: 'bg-slate-100 text-slate-800', icon: XCircle },
    refunded: { color: 'bg-purple-100 text-purple-800', icon: RefreshCw }
  };
  const cfg = config[status] || config.pending;
  const Icon = cfg.icon;
  return (
    <Badge className={`${cfg.color} gap-1`}>
      <Icon className="w-3 h-3" />
      {status}
    </Badge>
  );
};

export const getTypeBadge = (type) => {
  const config = {
    prepayment: 'bg-blue-100 text-blue-800',
    collection: 'bg-emerald-100 text-emerald-800',
    refund: 'bg-purple-100 text-purple-800'
  };
  return <Badge className={config[type] || 'bg-slate-100'}>{type}</Badge>;
};

export const getPaymentMethodBadge = (method) => {
  if (!method) return null;
  const config = {
    cash: 'bg-green-100 text-green-800',
    debit: 'bg-blue-100 text-blue-800',
    credit: 'bg-purple-100 text-purple-800',
    check: 'bg-amber-100 text-amber-800'
  };
  return <Badge className={config[method] || 'bg-slate-100'}>{method}</Badge>;
};