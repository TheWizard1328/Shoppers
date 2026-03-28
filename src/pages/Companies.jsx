import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import SmartRefreshIndicator from '@/components/layout/SmartRefreshIndicator';
import CompanyForm from '@/components/companies/CompanyForm';
import CompanyCard from '@/components/companies/CompanyCard';
import DeleteConfirmDialog from '@/components/deliveries/DeleteConfirmDialog';
import { getData } from '@/components/utils/dataManager';
import { createCompanyLocal, updateCompanyLocal, deleteCompanyLocal } from '@/components/utils/offlineMutations';

...

export default function CompaniesPage() {
  const [companies, setCompanies] = useState([]);
  const [stores, setStores] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [editingCompany, setEditingCompany] = useState(null);
  const [deletingCompany, setDeletingCompany] = useState(null);
  const [showForm, setShowForm] = useState(false);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    try {
      const [companiesData, storesData] = await Promise.all([
        getData('Company'),
        getData('Store')
      ]);
      setCompanies(companiesData || []);
      setStores(storesData || []);
    } catch (error) {
      console.error('Failed to load companies:', error);
      setCompanies([]);
      setStores([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleSaveCompany = async (companyData) => {
    const payload = {
      ...companyData,
      logo_url: companyData.logo_url || 'https://placehold.co/200x200?text=Logo'
    };

    if (editingCompany) {
      const updated = await updateCompanyLocal(editingCompany.id, payload);
      setCompanies((prev) => prev.map((company) => (company.id === editingCompany.id ? updated : company)));
    } else {
      const created = await createCompanyLocal(payload);
      setCompanies((prev) => [created, ...prev]);
    }

    setShowForm(false);
    setEditingCompany(null);
  };

  const handleDeleteCompany = async () => {
    if (!deletingCompany) return;
    await deleteCompanyLocal(deletingCompany.id);
    setCompanies((prev) => prev.filter((company) => company.id !== deletingCompany.id));
    setDeletingCompany(null);
  };

  const filteredCompanies = useMemo(() => {
    const term = searchTerm.toLowerCase();
    return companies.filter((company) =>
      (company.name || '').toLowerCase().includes(term) ||
      (company.contact_name || '').toLowerCase().includes(term) ||
      (company.contact_email || '').toLowerCase().includes(term)
    );
  }, [companies, searchTerm]);

  return (
    <div className="h-full overflow-y-auto p-6" style={{ background: 'var(--bg-slate-50)' }}>
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <SmartRefreshIndicator inline={true} />
            <div>
              <h1 className="text-3xl font-bold" style={{ color: 'var(--text-slate-900)' }}>Companies</h1>
              <p className="mt-1" style={{ color: 'var(--text-slate-600)' }}>Manage company profiles, contacts, linked stores, and primary settings.</p>
            </div>
          </div>

          <Button onClick={() => { setEditingCompany(null); setShowForm(true); }} className="bg-emerald-600 hover:bg-emerald-700">
            <Plus className="w-4 h-4 mr-2" />
            Add Company
          </Button>
        </div>

        <Card style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
          <CardContent className="p-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: 'var(--text-slate-400)' }} />
              <Input
                placeholder="Search companies, contacts, or emails..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-10"
              />
            </div>
          </CardContent>
        </Card>

        {isLoading ? (
          <div className="flex justify-center items-center h-64">
            <div className="text-center">
              <div className="animate-spin w-8 h-8 border-4 border-emerald-500 border-t-transparent rounded-full mx-auto mb-4"></div>
              <p style={{ color: 'var(--text-slate-600)' }}>Loading companies...</p>
            </div>
          </div>
        ) : filteredCompanies.length === 0 ? (
          <div className="text-center py-16">
            <h3 className="text-xl font-semibold" style={{ color: 'var(--text-slate-800)' }}>No companies found</h3>
            <p className="mt-2" style={{ color: 'var(--text-slate-500)' }}>
              {searchTerm ? `Your search for "${searchTerm}" did not return any results.` : 'Click "Add Company" to create your first company profile.'}
            </p>
          </div>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {filteredCompanies.map((company) => (
              <div key={company.id} className="relative">
                <CompanyCard company={company} stores={stores} onEdit={(item) => { setEditingCompany(item); setShowForm(true); }} />
                <div className="absolute top-4 right-16">
                  <Button variant="ghost" size="sm" className="text-red-600" onClick={() => setDeletingCompany(company)}>
                    Delete
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {showForm && (
        <CompanyForm
          company={editingCompany}
          stores={stores}
          onSave={handleSaveCompany}
          onCancel={() => {
            setShowForm(false);
            setEditingCompany(null);
          }}
        />
      )}

      {deletingCompany && (
        <DeleteConfirmDialog
          open={!!deletingCompany}
          onOpenChange={() => setDeletingCompany(null)}
          onConfirm={handleDeleteCompany}
          title="Delete Company"
          description={`Are you sure you want to delete ${deletingCompany.name}?`}
        />
      )}
    </div>
  );
}