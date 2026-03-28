import React from 'react';
import { Building2, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import SmartRefreshIndicator from '@/components/layout/SmartRefreshIndicator';

export default function CompaniesPage() {
  return (
    <div className="h-full overflow-y-auto p-6" style={{ background: 'var(--bg-slate-50)' }}>
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <SmartRefreshIndicator inline={true} />
            <div>
              <h1 className="text-3xl font-bold" style={{ color: 'var(--text-slate-900)' }}>Companies</h1>
              <p className="mt-1" style={{ color: 'var(--text-slate-600)' }}>A starting page for company management.</p>
            </div>
          </div>

          <Button className="bg-emerald-600 hover:bg-emerald-700">
            <Plus className="w-4 h-4 mr-2" />
            Add Company
          </Button>
        </div>

        <Card style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
          <CardContent className="p-8">
            <div className="flex flex-col items-center justify-center text-center py-12 gap-4">
              <div className="w-16 h-16 rounded-full bg-emerald-100 flex items-center justify-center">
                <Building2 className="w-8 h-8 text-emerald-600" />
              </div>
              <div className="space-y-2">
                <h2 className="text-xl font-semibold" style={{ color: 'var(--text-slate-900)' }}>Companies page ready</h2>
                <p className="max-w-2xl" style={{ color: 'var(--text-slate-600)' }}>
                  This is a clean default setup for managing companies. We can add company cards, forms, filters, contacts, settings, and relationships next.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}