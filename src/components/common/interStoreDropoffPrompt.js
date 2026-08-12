// src/components/common/interStoreDropoffPrompt.js
//
// Opens the InterStoreDropoffDialog and returns a Promise that resolves when
// the driver confirms (creates a matching drop-off) or skips. Used by the
// Complete handler for ISP-prefixed pickups so the prompt appears BEFORE the
// terminal action flips the isNextDelivery flag — this keeps the ISP pickup
// anchored as the route optimizer's origin while the driver decides.
//
// The dialog itself is rendered inside StopCard.jsx. To stay decoupled from
// that parent, this helper and the dialog communicate through a pair of
// window CustomEvents:
//   • 'interStoreDropoffConfirmed' — fired by the dialog's onConfirm AFTER the
//     new drop-off delivery is created. detail: { createdDeliveryId }.
//   • 'interStoreDropoffSkipped'   — fired by the dialog's onSkip (or by
//     onConfirm when no match exists and the Yes button is tapped anyway).
//
// Opening the dialog immediately (match=null shows a "looking up…" state) and
// resolving the backend match lookup in parallel avoids blocking the prompt on
// a server round-trip — the dialog is interactive the moment Complete is tapped.

export function promptInterStoreDropoff({
  delivery,
  setInterStoreMatch,
  setShowInterStoreDialog,
  base44,
}) {
  if (!delivery?.id || !setShowInterStoreDialog) {
    return Promise.resolve({ confirmed: false });
  }

  // Open the dialog right away so the user sees a prompt (not a frozen spinner).
  // The "Yes, create" button stays disabled until a matching ISD patient is
  // resolved by the backend lookup below — the empty state already shows the
  // amber "no match found" notice in that case.
  setInterStoreMatch?.(null);
  setShowInterStoreDialog?.(true);

  // Resolve the matching ISD patient in the background. When it arrives, the
  // dialog's "Yes, create" button enables; the user can still dismiss via "No".
  if (base44?.functions?.invoke) {
    base44.functions
      .invoke('findInterStoreDropoff', { deliveryId: delivery.id })
      .then((interStoreResponse) => {
        const interStoreData = interStoreResponse?.data || interStoreResponse;
        if (interStoreData?.match) setInterStoreMatch?.(interStoreData.match);
      })
      .catch(() => {});
  }

  return new Promise((resolve) => {
    const cleanup = () => {
      window.removeEventListener('interStoreDropoffConfirmed', onConfirm);
      window.removeEventListener('interStoreDropoffSkipped', onSkip);
    };
    const onConfirm = (event) => {
      cleanup();
      resolve({ confirmed: true, createdDeliveryId: event?.detail?.createdDeliveryId || null });
    };
    const onSkip = () => {
      cleanup();
      resolve({ confirmed: false });
    };
    window.addEventListener('interStoreDropoffConfirmed', onConfirm);
    window.addEventListener('interStoreDropoffSkipped', onSkip);
  });
}