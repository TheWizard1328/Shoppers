import React from 'react';
import { TabsContent } from '@/components/ui/tabs';
import AppSettingsPanel from '../admin/AppSettingsPanel';
import MessageRulesManager from '../admin/MessageRulesManager';
import GoogleAPILogViewer from '../admin/GoogleAPILogViewer';
import RemoteLogsTab from '../admin/RemoteLogsTab';
import PatientAnalysisReview from '../admin/PatientAnalysisReview';

export default function AdminUtilitiesExtraTabs({ appUsers = [], stores = [] }) {
  return (
    <>
      <TabsContent value="app-settings">
        <AppSettingsPanel />
      </TabsContent>

      <TabsContent value="message-rules">
        <MessageRulesManager />
      </TabsContent>

      <TabsContent value="api-logs">
        <GoogleAPILogViewer />
      </TabsContent>

      <TabsContent value="remote-logs">
        <RemoteLogsTab appUsers={appUsers || []} />
      </TabsContent>

      <TabsContent value="patient-analysis">
        <PatientAnalysisReview stores={stores || []} />
      </TabsContent>
    </>
  );
}