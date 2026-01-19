import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { format } from "date-fns";
import { RefreshCw, DollarSign, CheckCircle, XCircle, Clock, CreditCard, Trash2, Loader2 } from "lucide-react";
import { toast } from "sonner";

export default function SquareManagement() {
  const [transactions, setTransactions] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [deletingId, setDeletingId] = useState(null);

  const fetchTransactions = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await base44.entities.SquareTransaction.list('-created_date', 100);
      setTransactions(data || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchTransactions();
  }, []);

  const getStatusBadge = (status) => {
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

  const getTypeBadge = (type) => {
    const config = {
      prepayment: 'bg-blue-100 text-blue-800',
      collection: 'bg-emerald-100 text-emerald-800',
      refund: 'bg-purple-100 text-purple-800'
    };
    return <Badge className={config[type] || 'bg-slate-100'}>{type}</Badge>;
  };

  const getPaymentMethodBadge = (method) => {
    if (!method) return null;
    const config = {
      cash: 'bg-green-100 text-green-800',
      debit: 'bg-blue-100 text-blue-800',
      credit: 'bg-purple-100 text-purple-800',
      check: 'bg-amber-100 text-amber-800'
    };
    return <Badge className={config[method] || 'bg-slate-100'}>{method}</Badge>;
  };

  const handleDelete = async (transaction) => {
    if (!window.confirm(`Delete COD item "${transaction.item_name}"?\n\nThis will remove it from Square and mark the record as cancelled.`)) {
      return;
    }

    setDeletingId(transaction.id);
    try {
      // Call the delete function
      await base44.functions.invoke('squareDeleteCodItem', {
        deliveryId: transaction.delivery_id,
        reason: 'manual_delete'
      });

      // Update local state
      setTransactions(prev => prev.map(t => 
        t.id === transaction.id ? { ...t, status: 'cancelled' } : t
      ));

      toast.success('COD item deleted from Square');
    } catch (err) {
      console.error('Delete failed:', err);
      toast.error('Failed to delete: ' + err.message);
    } finally {
      setDeletingId(null);
    }
  };

  // Summary stats
  const stats = {
    total: transactions.length,
    pending: transactions.filter(t => t.status === 'pending').length,
    completed: transactions.filter(t => t.status === 'completed').length,
    failed: transactions.filter(t => t.status === 'failed').length,
    totalAmount: transactions.reduce((sum, t) => sum + (t.amount || 0), 0),
    pendingAmount: transactions.filter(t => t.status === 'pending').reduce((sum, t) => sum + (t.amount || 0), 0)
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <CreditCard className="w-8 h-8 text-emerald-600" />
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Square COD Management</h1>
            <p className="text-sm text-slate-500">Track and manage COD payments via Square</p>
          </div>
        </div>
        <Button onClick={fetchTransactions} disabled={isLoading} className="gap-2">
          <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <Card>
          <CardContent className="p-4">
            <div className="text-sm text-slate-500">Total Transactions</div>
            <div className="text-2xl font-bold">{stats.total}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-sm text-slate-500">Pending</div>
            <div className="text-2xl font-bold text-amber-600">{stats.pending}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-sm text-slate-500">Completed</div>
            <div className="text-2xl font-bold text-green-600">{stats.completed}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-sm text-slate-500">Pending Amount</div>
            <div className="text-2xl font-bold text-emerald-600">${stats.pendingAmount.toFixed(2)}</div>
          </CardContent>
        </Card>
      </div>

      {error && (
        <div className="p-4 bg-red-100 text-red-700 rounded-lg mb-6">
          Error: {error}
        </div>
      )}

      {/* Transactions Table */}
      <Card>
        <CardHeader>
          <CardTitle>Recent Transactions</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin w-8 h-8 border-4 border-emerald-500 border-t-transparent rounded-full" />
            </div>
          ) : transactions.length === 0 ? (
            <div className="text-center py-12 text-slate-500">
              <DollarSign className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p>No Square transactions yet</p>
              <p className="text-sm">COD items will appear here when deliveries are created with COD amounts</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b text-left text-sm text-slate-500">
                    <th className="p-3">Item Name</th>
                    <th className="p-3">Amount</th>
                    <th className="p-3">Type</th>
                    <th className="p-3">Status</th>
                    <th className="p-3">Payment</th>
                    <th className="p-3">Created</th>
                    <th className="p-3">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {transactions.map((tx) => (
                    <tr key={tx.id} className="border-b hover:bg-slate-50">
                      <td className="p-3">
                        <div className="font-medium">{tx.item_name || 'N/A'}</div>
                        {tx.square_catalog_object_id && (
                          <div className="text-xs text-slate-400 truncate max-w-[200px]">
                            {tx.square_catalog_object_id}
                          </div>
                        )}
                      </td>
                      <td className="p-3">
                        <span className="font-semibold text-emerald-600">
                          ${(tx.amount || 0).toFixed(2)}
                        </span>
                      </td>
                      <td className="p-3">{getTypeBadge(tx.type)}</td>
                      <td className="p-3">{getStatusBadge(tx.status)}</td>
                      <td className="p-3">{getPaymentMethodBadge(tx.payment_method)}</td>
                      <td className="p-3 text-sm text-slate-500">
                        {tx.created_date ? new Date(tx.created_date).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }) : 'N/A'}
                      </td>
                      <td className="p-3">
                        {tx.status === 'pending' && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDelete(tx)}
                            disabled={deletingId === tx.id}
                            className="text-red-600 hover:text-red-700 hover:bg-red-50"
                          >
                            {deletingId === tx.id ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <Trash2 className="w-4 h-4" />
                            )}
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}