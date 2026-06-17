import React, { useEffect, useRef } from "react";
import { AnimatePresence, motion, useMotionValue, useTransform } from "framer-motion";
import PatientDetails from "./PatientDetails";

/**
 * MobilePatientDetailsSheet
 * Slides up from the bottom when a patient is selected on mobile.
 * Reuses the existing PatientDetails panel — no logic duplication.
 */
export default function MobilePatientDetailsSheet({
  patient,
  deliveries,
  deliveryStats,
  currentUser,
  onClose,
  onEditDelivery,
  allPatients,
  stores,
  drivers,
  allDeliveries,
}) {
  const isOpen = !!patient;
  const dragY = useMotionValue(0);
  const handleRef = useRef(null);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e) => { if (e.key === "Escape") onClose?.(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, onClose]);

  // Reset drag position when sheet opens
  useEffect(() => {
    if (isOpen) dragY.set(0);
  }, [isOpen, dragY]);

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            key="backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-[800] bg-black/40 lg:hidden"
            onClick={onClose}
          />

          {/* Sheet */}
          <motion.div
            key="sheet"
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", damping: 30, stiffness: 300 }}
            style={{
              maxHeight: "95dvh",
              background: "var(--bg-slate-100)",
              boxShadow: "0 -4px 32px rgba(0,0,0,0.18)",
              paddingBottom: "env(safe-area-inset-bottom, 0px)",
              y: dragY,
            }}
            className="fixed left-0 right-0 bottom-0 z-[810] rounded-t-2xl overflow-hidden flex flex-col lg:hidden"
          >
            {/* Drag handle — drag down to dismiss */}
            <motion.div
              ref={handleRef}
              className="flex-shrink-0 flex justify-center pt-2 pb-1 cursor-grab active:cursor-grabbing"
              drag="y"
              dragConstraints={{ top: 0, bottom: 400 }}
              dragElastic={{ top: 0, bottom: 0.3 }}
              style={{ touchAction: "none" }}
              onDragEnd={(_, info) => {
                if (info.offset.y > 80 || info.velocity.y > 400) {
                  onClose?.();
                } else {
                  dragY.set(0);
                }
              }}
              dragMomentum={false}
            >
              <div className="w-10 h-1 rounded-full bg-slate-300" />
            </motion.div>

            {/* PatientDetails fills the sheet */}
            <div className="flex-1 min-h-0 overflow-hidden">
              <PatientDetails
                patient={patient}
                deliveries={deliveries}
                deliveryStats={deliveryStats}
                currentUser={currentUser}
                onEditDelivery={onEditDelivery}
                allPatients={allPatients}
                stores={stores}
                drivers={drivers}
                allDeliveries={allDeliveries}
                onClose={onClose}
              />
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}