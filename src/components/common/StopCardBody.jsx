import React, { useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { parseISO, isBefore } from "date-fns";
import {
  StopCardPhoneRow,
  StopCardCodSection,
  StopCardPatientInfoSection,
  StopCardPendingPickupsSection,
  StopCardNotesSection
} from "./StopCardExpandedSections";

export default function StopCardBody({
  isExpanded,
  isStrippedForDispatcher,
  finalDisplayPhone,
  alternateDisplayPhone,
  isFinishedDelivery,
  isPickup,
  hasCODRequired,
  codTotalRequired,
  codPayments,
  setCodPayments,
  showCODCollection,
  setShowCODCollection,
  handleAddCODPayment,
  isStrippedForDriver,
  currentUser,
  codTotalCollected,
  isCODComplete,
  delivery,
  patient,
  store,
  patients,
  pendingPickups,
  canAccessAcceptButtons,
  isAcceptingAll,
  acceptButtonText,
  handleAcceptAllStops,
  onEdit,
  onCODUpdate,
  allDeliveries,
  FINISHED_STATUSES,
  forceRefreshDriverDeliveries,
  isCompleting,
  setIsCompleting,
  onSelectionChange,
  onClick,
  notesInput,
  setNotesInput,
  onNotesUpdate,
  isCompleted,
  userHasRole,
  Textarea,
  isAppOwnerFn,
  isPastDate
}) {
  const handleNotesBlur = () => {
    if (!notesInput.trim() || notesInput.trim() === 'No driver notes') {
      setNotesInput('No driver notes');
      if (delivery?.delivery_notes && delivery.delivery_notes.trim() && onNotesUpdate) {
        onNotesUpdate(delivery.id, '');
      }
      return;
    }
    if (notesInput !== delivery.delivery_notes && onNotesUpdate) {
      onNotesUpdate(delivery.id, notesInput);
    }
  };

  const handleNotesKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (notesInput !== delivery.delivery_notes && onNotesUpdate) {
        onNotesUpdate(delivery.id, notesInput);
      }
      e.target.blur();
    }
  };

  const lastDeliveryBadgeDate = useMemo(() => {
    if (isPickup || !delivery?.delivery_date) return null;

    const currentDeliveryDate = parseISO(`${delivery.delivery_date}T00:00:00`);

    const priorCompletedDates = (allDeliveries || [])
      .filter((item) =>
        item &&
        item.id !== delivery.id &&
        item.patient_id === delivery.patient_id &&
        item.delivery_date &&
        item.status === 'completed'
      )
      .map((item) => item.delivery_date)
      .filter((dateStr) => {
        const itemDate = parseISO(`${dateStr}T00:00:00`);
        return isBefore(itemDate, currentDeliveryDate);
      })
      .sort((a, b) => b.localeCompare(a));

    if (priorCompletedDates[0]) return priorCompletedDates[0];

    if (patient?.last_delivery_date) {
      const patientLastDate = parseISO(`${patient.last_delivery_date}T00:00:00`);
      if (isBefore(patientLastDate, currentDeliveryDate)) {
        return patient.last_delivery_date;
      }
    }

    return null;
  }, [allDeliveries, delivery?.delivery_date, delivery?.id, delivery?.patient_id, isPickup, patient?.last_delivery_date]);

  return (
    <>
      {/* BODY SECTION - Expandable - Always show when expanded (BUT never for dispatcher-stripped cards) */}
      <AnimatePresence>
        {isExpanded && !isStrippedForDispatcher &&
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.2 }}
          className="overflow-hidden">
          
            <div className="pt-1 space-y-2 border-t" style={{ borderColor: 'var(--border-slate-200)' }}>
              <StopCardPhoneRow
                isPickup={isPickup}
                finalDisplayPhone={finalDisplayPhone}
                alternateDisplayPhone={alternateDisplayPhone}
              />

              <StopCardCodSection
                hasCODRequired={hasCODRequired}
                isPickup={isPickup}
                codTotalRequired={codTotalRequired}
                currentUser={currentUser}
                userHasRole={userHasRole}
                isStrippedForDriver={isStrippedForDriver}
                codPayments={codPayments}
                setCodPayments={setCodPayments}
                showCODCollection={showCODCollection}
                setShowCODCollection={setShowCODCollection}
                codTotalCollected={codTotalCollected}
                isFinishedDelivery={isFinishedDelivery}
                onCODUpdate={onCODUpdate}
                delivery={delivery}
                allDeliveries={allDeliveries}
                FINISHED_STATUSES={FINISHED_STATUSES}
                forceRefreshDriverDeliveries={forceRefreshDriverDeliveries}
                isCompleting={isCompleting}
                setIsCompleting={setIsCompleting}
                onSelectionChange={onSelectionChange}
                onClick={onClick}
                isCODComplete={isCODComplete}
              />

              <StopCardPatientInfoSection
                isStrippedForDriver={isStrippedForDriver}
                isFinishedDelivery={isFinishedDelivery}
                isPickup={isPickup}
                isPastDate={isPastDate}
                patient={patient}
              />

              <StopCardPendingPickupsSection
                isFinishedDelivery={isFinishedDelivery}
                isPickup={isPickup}
                delivery={delivery}
                pendingPickups={pendingPickups}
                canAccessAcceptButtons={canAccessAcceptButtons}
                isAcceptingAll={isAcceptingAll}
                handleAcceptAllStops={handleAcceptAllStops}
                acceptButtonText={acceptButtonText}
                onEdit={onEdit}
                patients={patients}
                store={store}
              />

              <StopCardNotesSection
                lastDeliveryBadgeDate={lastDeliveryBadgeDate}
                notesInput={notesInput}
                setNotesInput={setNotesInput}
                handleNotesBlur={handleNotesBlur}
                handleNotesKeyDown={handleNotesKeyDown}
                delivery={delivery}
                onNotesUpdate={onNotesUpdate}
                Textarea={Textarea}
              />
            </div>
                </motion.div>
        }
                </AnimatePresence>
    </>);

}