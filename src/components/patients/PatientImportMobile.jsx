import React from "react";
import PatientImport from "./PatientImport";
import { getUserAgentInfo } from "../utils/deviceUtils";

export default function PatientImportMobile({ onImportComplete, onImportStart, currentUser, onClose }) {
  const { deviceType } = getUserAgentInfo();
  const isMobile = deviceType === 'Mobile';

  // On mobile, render the PatientImport with responsive wrapper
  if (isMobile) {
    return (
      <div className="fixed inset-0 z-[9998]" style={{ overscrollBehavior: 'contain' }}>
        <PatientImport
          onImportComplete={onImportComplete}
          onImportStart={onImportStart}
          currentUser={currentUser}
          onClose={onClose}
        />
      </div>
    );
  }

  // On desktop, use the standard PatientImport
  return (
    <PatientImport
      onImportComplete={onImportComplete}
      onImportStart={onImportStart}
      currentUser={currentUser}
      onClose={onClose}
    />
  );
}