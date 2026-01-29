import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { FileText, DollarSign, RefreshCw, Loader2, CheckCircle2, AlertCircle, Send, X } from 'lucide-react';
import { format } from 'date-fns';

export default function StoreInvoices() {
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear().toString());
  const [selectedMonth, setSelectedMonth] = useState(String(new Date().getMonth() + 1).padStart(2, '0'));
  const [invoices, setInvoices] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [expandedInvoice, setExpandedInvoice] = useState(null);
  const [approvalNotes, setApprovalNotes] = useState('');

  const availableYears = Array.from({ length: 3 }, (_, i) => 
    (new Date().getFullYear() - i).toString()
  );

  const months = Array.from({ length: 12 }, (_, i) => ({
    value: String(i + 1).padStart(2, '0'),
    label: format(new Date(2024, i, 1), 'MMMM')
  }));

  // Load invoices
  const loadInvoices = async () => {
    setIsLoading(true);
    try {
      const results = await base44.entities.Invoice.filter({
        billing_year: parseInt(selectedYear),
        billing_month: parseInt(selectedMonth)
      });
      setInvoices(results || []);
    } catch (error) {
      console.error('Error loading invoices:', error);
      setInvoices([]);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadInvoices();
  }, [selectedYear, selectedMonth]);

  // Generate invoices for the period
  const handleGenerateInvoices = async () => {
    if (!window.confirm(`Generate invoices for ${format(new Date(parseInt(selectedYear), parseInt(selectedMonth) - 1, 1), 'MMMM yyyy')}?`)) {
      return;
    }

    setIsGenerating(true);
    try {
      const response = await base44.functions.invoke('generateStoreInvoices', {
        year: parseInt(selectedYear),
        month: parseInt(selectedMonth)
      });

      const data = response?.data || response;
      
      if (data.error) {
        if (data.error.includes('already exist')) {
          alert(`Invoices already exist for this period (${data.existingCount} invoices)`);
        } else {
          alert(`Error: ${data.error}`);
        }
      } else {
        alert(`Successfully generated ${data.invoices.length} invoices`);
        loadInvoices();
      }
    } catch (error) {
      alert('Error generating invoices: ' + error.message);
    } finally {
      setIsGenerating(false);
    }
  };

  // Approve invoice
  const handleApproveInvoice = async (invoiceId) => {
    try {
      const now = new Date();
      await base44.entities.Invoice.update(invoiceId, {
        status: 'approved',
        approved_at: now.toISOString(),
        notes: approvalNotes
      });
      setApprovalNotes('');
      setExpandedInvoice(null);
      loadInvoices();
      alert('Invoice approved');
    } catch (error) {
      alert('Error approving invoice: ' + error.message);
    }
  };

  // Send invoice
  const handleSendInvoice = async (invoiceId) => {
    try {
      const now = new Date();
      await base44.entities.Invoice.update(invoiceId, {
        status: 'sent',
        sent_at: now.toISOString()
      });
      loadInvoices();
      alert('Invoice marked as sent');
    } catch (error) {
      alert('Error sending invoice: ' + error.message);
    }
  };

  // Reject invoice
  const handleRejectInvoice = async (invoiceId) => {
    try {
      await base44.entities.Invoice.update(invoiceId, {
        status: 'draft',
        approved_at: null,
        approved_by: null
      });
      loadInvoices();
      alert('Invoice rejected');
    } catch (error) {
      alert('Error rejecting invoice: ' + error.message);
    }
  };

  const statusColors = {
    draft: 'bg-slate-100 text-slate-800',
    pending_approval: 'bg-yellow-100 text-yellow-800',
    approved: 'bg-green-100 text-green-800',
    sent: 'bg-blue-100 text-blue-800',
    paid: 'bg-emerald-100 text-emerald-800',
    overdue: 'bg-red-100 text-red-800'
  };

  const draftInvoices = invoices.filter(inv => inv.status === 'draft');
  const pendingInvoices = invoices.filter(inv => inv.status === 'pending_approval');
  const approvedInvoices = invoices.filter(inv => inv.status === 'approved');
  const sentInvoices = invoices.filter(inv => inv.status === 'sent');

  const totalDraft = draftInvoices.reduce((sum, inv) => sum + (inv.total_amount_due || 0), 0);
  const totalApproved = approvedInvoices.reduce((sum, inv) => sum + (inv.total_amount_due || 0), 0);
  const totalSent = sentInvoices.reduce((sum, inv) => sum + (inv.total_amount_due || 0), 0);

  return (
    <div className="min-h-screen p-6" style={{ background: 'var(--bg-slate-50)' }}>
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center gap-3 mb-8">
          <FileText className="w-8 h-8 text-slate-700" />
          <div>
            <h1 className="text-3xl font-bold" style={{ color: 'var(--text-slate-900)' }}>
              Store Invoices
            </h1>
            <p className="text-sm text-slate-600">
              Generate, review, and manage store fee invoices
            </p>
          </div>
        </div>

        {/* Period Selection & Actions */}
        <Card>
          <CardHeader>
            <CardTitle>Generate Invoices</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-col md:flex-row gap-4 items-end">
              <div className="flex-1">
                <label className="text-sm font-medium block mb-2">Year</label>
                <Select value={selectedYear} onValueChange={setSelectedYear}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {availableYears.map((year) => (
                      <SelectItem key={year} value={year}>{year}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex-1">
                <label className="text-sm font-medium block mb-2">Month</label>
                <Select value={selectedMonth} onValueChange={setSelectedMonth}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {months.map((month) => (
                      <SelectItem key={month.value} value={month.value}>{month.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button 
                onClick={handleGenerateInvoices}
                disabled={isGenerating}
                className="gap-2"
              >
                {isGenerating ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Generating...
                  </>
                ) : (
                  <>
                    <RefreshCw className="w-4 h-4" />
                    Generate Invoices
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Summary Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card>
            <CardContent className="pt-6">
              <div className="text-sm text-slate-600 mb-2">Draft Invoices</div>
              <div className="text-2xl font-bold mb-1">{draftInvoices.length}</div>
              <div className="text-sm text-slate-500">${totalDraft.toFixed(2)}</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="text-sm text-slate-600 mb-2">Approved & Pending</div>
              <div className="text-2xl font-bold mb-1">{approvedInvoices.length}</div>
              <div className="text-sm text-slate-500">${totalApproved.toFixed(2)}</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="text-sm text-slate-600 mb-2">Sent Invoices</div>
              <div className="text-2xl font-bold mb-1">{sentInvoices.length}</div>
              <div className="text-sm text-slate-500">${totalSent.toFixed(2)}</div>
            </CardContent>
          </Card>
        </div>

        {/* Invoices Tabs */}
        {isLoading ? (
          <Card>
            <CardContent className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-emerald-500 mr-2" />
              <span>Loading invoices...</span>
            </CardContent>
          </Card>
        ) : (
          <Tabs defaultValue="draft" className="w-full">
            <TabsList>
              <TabsTrigger value="draft">Draft ({draftInvoices.length})</TabsTrigger>
              <TabsTrigger value="approved">Approved ({approvedInvoices.length})</TabsTrigger>
              <TabsTrigger value="sent">Sent ({sentInvoices.length})</TabsTrigger>
            </TabsList>

            {/* Draft Invoices */}
            <TabsContent value="draft" className="space-y-4">
              {draftInvoices.length === 0 ? (
                <Card>
                  <CardContent className="py-8 text-center text-slate-500">
                    No draft invoices for this period
                  </CardContent>
                </Card>
              ) : (
                draftInvoices.map((invoice) => (
                  <InvoiceCard
                    key={invoice.id}
                    invoice={invoice}
                    isExpanded={expandedInvoice === invoice.id}
                    onToggleExpand={() => setExpandedInvoice(expandedInvoice === invoice.id ? null : invoice.id)}
                    onApprove={() => handleApproveInvoice(invoice.id)}
                    approvalNotes={approvalNotes}
                    setApprovalNotes={setApprovalNotes}
                    statusColors={statusColors}
                  />
                ))
              )}
            </TabsContent>

            {/* Approved Invoices */}
            <TabsContent value="approved" className="space-y-4">
              {approvedInvoices.length === 0 ? (
                <Card>
                  <CardContent className="py-8 text-center text-slate-500">
                    No approved invoices for this period
                  </CardContent>
                </Card>
              ) : (
                approvedInvoices.map((invoice) => (
                  <Card key={invoice.id}>
                    <CardContent className="pt-6">
                      <div className="flex items-center justify-between gap-4">
                        <div className="flex-1">
                          <div className="flex items-center gap-3 mb-2">
                            <span className="font-semibold">{invoice.invoice_number}</span>
                            <Badge className={statusColors[invoice.status]}>
                              {invoice.status}
                            </Badge>
                          </div>
                          <div className="text-sm text-slate-600">{invoice.store_name}</div>
                          <div className="text-sm text-slate-500">
                            {invoice.total_billable_deliveries} deliveries × ${invoice.app_fee_per_delivery.toFixed(2)}
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="text-2xl font-bold">${invoice.total_amount_due.toFixed(2)}</div>
                          <Button 
                            onClick={() => handleSendInvoice(invoice.id)}
                            size="sm"
                            className="mt-2 gap-2"
                          >
                            <Send className="w-4 h-4" />
                            Send
                          </Button>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))
              )}
            </TabsContent>

            {/* Sent Invoices */}
            <TabsContent value="sent" className="space-y-4">
              {sentInvoices.length === 0 ? (
                <Card>
                  <CardContent className="py-8 text-center text-slate-500">
                    No sent invoices for this period
                  </CardContent>
                </Card>
              ) : (
                sentInvoices.map((invoice) => (
                  <Card key={invoice.id}>
                    <CardContent className="pt-6">
                      <div className="flex items-center justify-between gap-4">
                        <div className="flex-1">
                          <div className="flex items-center gap-3 mb-2">
                            <span className="font-semibold">{invoice.invoice_number}</span>
                            <Badge className={statusColors[invoice.status]}>
                              {invoice.status}
                            </Badge>
                          </div>
                          <div className="text-sm text-slate-600">{invoice.store_name}</div>
                          <div className="text-sm text-slate-500">
                            Sent: {format(new Date(invoice.sent_at), 'MMM dd, yyyy')}
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="text-2xl font-bold">${invoice.total_amount_due.toFixed(2)}</div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))
              )}
            </TabsContent>
          </Tabs>
        )}
      </div>
    </div>
  );
}

// Invoice Card Component for Draft invoices with approval form
function InvoiceCard({ 
  invoice, 
  isExpanded, 
  onToggleExpand, 
  onApprove, 
  approvalNotes, 
  setApprovalNotes,
  statusColors 
}) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div 
          className="flex items-center justify-between gap-4 cursor-pointer"
          onClick={onToggleExpand}
        >
          <div className="flex-1">
            <div className="flex items-center gap-3 mb-2">
              <span className="font-semibold">{invoice.invoice_number}</span>
              <Badge className={statusColors[invoice.status]}>
                {invoice.status}
              </Badge>
            </div>
            <div className="text-sm text-slate-600">{invoice.store_name}</div>
            <div className="text-sm text-slate-500">
              {invoice.total_billable_deliveries} deliveries × ${invoice.app_fee_per_delivery.toFixed(2)}
            </div>
          </div>
          <div className="text-right">
            <div className="text-2xl font-bold">${invoice.total_amount_due.toFixed(2)}</div>
          </div>
        </div>

        {isExpanded && (
          <div className="mt-6 pt-6 border-t space-y-4">
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="text-slate-600">Subtotal:</span>
                <div className="font-semibold">${invoice.subtotal.toFixed(2)}</div>
              </div>
              <div>
                <span className="text-slate-600">Taxes:</span>
                <div className="font-semibold">${invoice.taxes.toFixed(2)}</div>
              </div>
              <div className="col-span-2">
                <span className="text-slate-600">Billing Period:</span>
                <div className="font-semibold">
                  {format(new Date(invoice.billing_start_date), 'MMM dd, yyyy')} - {format(new Date(invoice.billing_end_date), 'MMM dd, yyyy')}
                </div>
              </div>
            </div>

            <div>
              <label className="text-sm font-medium block mb-2">Review Notes</label>
              <textarea 
                className="w-full border rounded-md p-2 text-sm"
                rows={3}
                value={approvalNotes}
                onChange={(e) => setApprovalNotes(e.target.value)}
                placeholder="Add notes before approval..."
              />
            </div>

            <div className="flex gap-3">
              <Button 
                onClick={() => onApprove()}
                className="flex-1 gap-2 bg-emerald-600 hover:bg-emerald-700"
              >
                <CheckCircle2 className="w-4 h-4" />
                Approve
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}