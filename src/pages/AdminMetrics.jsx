import React, { useState, useEffect, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { BarChart3, DollarSign, Store, Package, RefreshCw, Loader2, Settings, MapPin, FileText, Activity, Share2 } from 'lucide-react';
import { useAppData } from '@/components/utils/AppDataContext';
import StoreMetricsPanel from '../components/admin/StoreMetricsPanel';
import MonthlyStoreMetricsGrid from '../components/admin/MonthlyStoreMetricsGrid';
import GoogleAPILogViewer from '../components/admin/GoogleAPILogViewer';
import AppSettingsPanel from '../components/admin/AppSettingsPanel';
import PolylineViewer from '../components/admin/PolylineViewer';
import DeliveryDataTable from '../components/admin/DeliveryDataTable';
import PatientDataTable from '../components/admin/PatientDataTable';
import ScreenshotShareModal from '../components/common/ScreenshotShareModal';
import html2canvas from 'html2canvas';
import { toast } from 'sonner';
import { useUser } from '@/components/utils/UserContext';
import { isAppOwner } from '@/components/utils/userRoles';

export default function AdminMetrics() {
  const { user: currentUser } = useUser();
  const appData = useAppData();
  const deliveries = appData?.deliveries || [];
  const patients = appData?.patients || [];
  const stores = appData?.stores || [];
  const users = appData?.users || [];
  const drivers = appData?.drivers || [];
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear().toString());
  const [selectedMonth, setSelectedMonth] = useState(null); // null = show yearly grid
  const [selectedStoreMonth, setSelectedStoreMonth] = useState(null); // {month, storeId, storeName, storeAbbr}
  const [metricsData, setMetricsData] = useState(null);
  const [isLoadingMetrics, setIsLoadingMetrics] = useState(true);
  const [metricsViewMode, setMetricsViewMode] = useState('deliveries'); // 'deliveries' or 'fees'
  const [showEnvelopeAdjustedTotals, setShowEnvelopeAdjustedTotals] = useState(false);
  const [isCapturingScreenshot, setIsCapturingScreenshot] = useState(false);
  const [screenshotDataUrl, setScreenshotDataUrl] = useState(null);
  const [showScreenshotModal, setShowScreenshotModal] = useState(false);
  const contentRef = React.useRef(null);

  const availableYears = useMemo(() => {
    const currentYear = new Date().getFullYear();
    return [currentYear, currentYear - 1, currentYear - 2].map(y => y.toString());
  }, []);

  // Load metrics for the grid
  const loadMetrics = async () => {
    setIsLoadingMetrics(true);
    try {
      const response = await base44.functions.invoke('getAdminMetricsAndPayrollData', {
        adminMetricsYear: parseInt(selectedYear),
        adminMetricsCityId: 'all'
      });
      const data = response?.data || response;
      setMetricsData(data?.adminMetrics || null);
    } catch (error) {
      console.error('Failed to load admin metrics:', error);
      setMetricsData(null);
    } finally {
      setIsLoadingMetrics(false);
    }
  };

  useEffect(() => {
    loadMetrics();
  }, [selectedYear]);

  const handleMonthClick = (month) => {
    if (selectedMonth === month) {
      setSelectedMonth(null);
      setSelectedStoreMonth(null);
    } else {
      setSelectedMonth(month);
      setSelectedStoreMonth(null);
    }
  };

  const handleStoreMonthClick = (month, storeId, storeAbbr, storeName) => {
    if (selectedStoreMonth?.month === month && selectedStoreMonth?.storeId === storeId) {
      setSelectedStoreMonth(null);
    } else {
      setSelectedStoreMonth({ month, storeId, storeAbbr, storeName });
    }
  };

  const handleResetView = () => {
    setSelectedMonth(null);
    setSelectedStoreMonth(null);
  };

  const handleCaptureScreenshot = async () => {
     const elem = contentRef.current;

     setIsCapturingScreenshot(true);
     toast.info('Capturing screenshot...');

     if (!elem) {
       toast.error('Content not found');
       setIsCapturingScreenshot(false);
       return;
     }

     try {

      // Hide the controls temporarily
      const controlsElement = document.getElementById('screenshot-controls');
      if (controlsElement) {
        controlsElement.style.display = 'none';
      }

      // Small delay to ensure UI updates
      await new Promise(resolve => setTimeout(resolve, 100));

      // Capture only the content area
      const canvas = await html2canvas(elem, {
        allowTaint: true,
        useCORS: true,
        scale: 2,
        backgroundColor: '#f8fafc'
      });

      // Show controls again
      if (controlsElement) {
        controlsElement.style.display = 'flex';
      }

      const dataUrl = canvas.toDataURL('image/png');
      setScreenshotDataUrl(dataUrl);
      setShowScreenshotModal(true);
      toast.success('Screenshot captured!');
    } catch (error) {
      console.error('Screenshot error:', error);
      toast.error('Failed to capture screenshot');
      
      // Make sure controls are visible again even if error
      const controlsElement = document.getElementById('screenshot-controls');
      if (controlsElement) {
        controlsElement.style.display = 'flex';
      }
    } finally {
      setIsCapturingScreenshot(false);
    }
  };

  return (
    <div className="min-h-screen p-6" style={{ background: 'var(--bg-slate-50)' }}>
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div className="flex items-center gap-3">
            <BarChart3 className="w-8 h-8 text-slate-700" />
            <div>
              <h1 className="text-3xl font-bold" style={{ color: 'var(--text-slate-900)' }}>
                Admin Metrics
              </h1>
              <p className="text-sm text-slate-600">
                System-wide analytics, metrics, and data management
              </p>
            </div>
          </div>

          <div id="screenshot-controls" className="flex items-center gap-3">
            <Select value={selectedYear} onValueChange={setSelectedYear}>
              <SelectTrigger className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {availableYears.map((year) => (
                  <SelectItem key={year} value={year}>
                    {year}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Button 
              onClick={handleCaptureScreenshot} 
              variant="outline" 
              disabled={isCapturingScreenshot}
              className="gap-2"
            >
              {isCapturingScreenshot ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Share2 className="w-4 h-4" />
              )}
              Share
            </Button>

            <Button onClick={loadMetrics} variant="outline" size="icon">
              <RefreshCw className={`w-4 h-4 ${isLoadingMetrics ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </div>

        {/* Tabs for different admin sections */}
        <Tabs defaultValue="deliveries" className="w-full" ref={contentRef}>
          <TabsList className={`grid w-full ${currentUser && isAppOwner(currentUser) ? 'grid-cols-3 lg:grid-cols-6' : 'grid-cols-2'}`}>
            <TabsTrigger value="deliveries">Deliveries</TabsTrigger>
            <TabsTrigger value="store-fees">Store Fees</TabsTrigger>
            {currentUser && isAppOwner(currentUser) && (
              <>
                <TabsTrigger value="api-logs">API Logs</TabsTrigger>
                <TabsTrigger value="polylines">Polylines</TabsTrigger>
                <TabsTrigger value="settings">Settings</TabsTrigger>
                <TabsTrigger value="data">Data Tables</TabsTrigger>
              </>
            )}
          </TabsList>

          {/* Deliveries Grid */}
          <TabsContent value="deliveries" className="space-y-6">
            {isLoadingMetrics ? (
              <Card>
                <CardContent className="flex items-center justify-center py-12">
                  <Loader2 className="w-6 h-6 animate-spin text-emerald-500 mr-2" />
                  <span className="text-slate-600">Loading metrics...</span>
                </CardContent>
              </Card>
            ) : (
              <>
                <MonthlyStoreMetricsGrid
                  metricsData={metricsData}
                  selectedYear={selectedYear}
                  onMonthClick={handleMonthClick}
                  onStoreMonthClick={handleStoreMonthClick}
                  selectedMonth={selectedMonth}
                  selectedStoreMonth={selectedStoreMonth}
                  onResetView={handleResetView}
                  onViewModeChange={setMetricsViewMode}
                  metricsViewMode={metricsViewMode}
                  showEnvelopeAdjustedTotals={showEnvelopeAdjustedTotals}
                  onEnvelopeToggleChange={setShowEnvelopeAdjustedTotals}
                />

                {/* Month-specific delivery table */}
                {selectedMonth && !selectedStoreMonth && (
                  <DeliveryDataTable
                    deliveries={deliveries}
                    patients={patients}
                    stores={stores}
                    users={users}
                    selectedYear={selectedYear}
                    selectedMonth={selectedMonth}
                  />
                )}

                {/* Store-month specific delivery table */}
                {selectedStoreMonth && (
                  <DeliveryDataTable
                    deliveries={deliveries}
                    patients={patients}
                    stores={stores}
                    users={users}
                    selectedYear={selectedYear}
                    selectedMonth={selectedStoreMonth.month}
                    selectedStoreId={selectedStoreMonth.storeId}
                    storeFilterLabel={`${selectedStoreMonth.storeAbbr} - ${selectedStoreMonth.storeName}`}
                  />
                )}
              </>
            )}
          </TabsContent>

          {/* Store App Fees */}
          <TabsContent value="store-fees" className="space-y-6">
            <StoreMetricsPanel />
          </TabsContent>

          {currentUser && isAppOwner(currentUser) && (
            <>
              {/* Google API Logs */}
              <TabsContent value="api-logs" className="space-y-6">
                <GoogleAPILogViewer />
              </TabsContent>

              {/* Polylines Viewer */}
              <TabsContent value="polylines" className="space-y-6">
                <PolylineViewer users={users} />
              </TabsContent>

              {/* App Settings */}
              <TabsContent value="settings" className="space-y-6">
                <AppSettingsPanel />
              </TabsContent>

              {/* Data Tables */}
              <TabsContent value="data" className="space-y-6">
                <Tabs defaultValue="deliveries" className="w-full">
                  <TabsList>
                    <TabsTrigger value="deliveries">All Deliveries</TabsTrigger>
                    <TabsTrigger value="patients">All Patients</TabsTrigger>
                  </TabsList>
                  
                  <TabsContent value="deliveries">
                    <DeliveryDataTable
                      deliveries={deliveries}
                      patients={patients}
                      stores={stores}
                      users={users}
                      selectedYear={selectedYear}
                      showAllData={true}
                    />
                  </TabsContent>
                  
                  <TabsContent value="patients">
                    <PatientDataTable
                      patients={patients}
                      stores={stores}
                    />
                  </TabsContent>
                </Tabs>
              </TabsContent>
            </>
          )}
        </Tabs>
      </div>

      {/* Screenshot Share Modal */}
      <ScreenshotShareModal
        isOpen={showScreenshotModal}
        onClose={() => setShowScreenshotModal(false)}
        imageDataUrl={screenshotDataUrl}
        filename={`admin-metrics-${selectedYear}.png`}
      />
    </div>
  );
}