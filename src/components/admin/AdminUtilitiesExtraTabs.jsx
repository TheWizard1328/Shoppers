import React from 'react';
import { TabsContent, Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import AppSettingsPanel from '../admin/AppSettingsPanel';
import MessageRulesManager from '../admin/MessageRulesManager';
import MessageRuleBuilder from '../admin/MessageRuleBuilder';
import GoogleAPILogViewer from '../admin/GoogleAPILogViewer';
import RemoteLogsTab from '../admin/RemoteLogsTab';
import PatientAnalysisReview from '../admin/PatientAnalysisReview';
import DriverSyncManagementTab from '../admin/DriverSyncManagementTab';
import DocAccessRequestsPanel from '../admin/DocAccessRequestsPanel';

export default function AdminUtilitiesExtraTabs({ appUsers = [], stores = [], currentUser }) {
  return (
    <>
      <TabsContent value="sync-management" className="mt-4 md:mt-6">
        <DriverSyncManagementTab appUsers={appUsers || []} />
      </TabsContent>
      <TabsContent value="app-settings" className="mt-4 md:mt-6 flex-1 min-h-0 overflow-hidden">
        <AppSettingsPanel />
      </TabsContent>

      <TabsContent value="message-rules">
        {/* Sub-tabs: old system (Messages) vs new system (Rule Builder) */}
        <Tabs defaultValue="rule-builder">
          <TabsList className="mb-3">
            <TabsTrigger value="rule-builder" className="text-xs">Rule Builder (New)</TabsTrigger>
            <TabsTrigger value="legacy-messages" className="text-xs">Legacy Messages</TabsTrigger>
          </TabsList>
          <TabsContent value="rule-builder">
            <MessageRuleBuilder />
          </TabsContent>
          <TabsContent value="legacy-messages">
            <MessageRulesManager />
          </TabsContent>
        </Tabs>
      </TabsContent>

      <TabsContent value="api-logs" className="ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
        <GoogleAPILogViewer />
      </TabsContent>

      <TabsContent value="remote-logs">
        <RemoteLogsTab appUsers={appUsers || []} />
      </TabsContent>

      <TabsContent value="patient-analysis">
        <PatientAnalysisReview stores={stores || []} />
      </TabsContent>

      <TabsContent value="doc-requests" className="mt-4 md:mt-6">
        <DocAccessRequestsPanel currentUser={currentUser} />
      </TabsContent>
    </>);

}
