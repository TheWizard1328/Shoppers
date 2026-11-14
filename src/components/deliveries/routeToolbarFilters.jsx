import { format } from 'date-fns';
import { getDriverDisplayName } from '../utils/driverUtils';
import { sortUsers } from '../utils/sorting';
import { userHasRole } from '../utils/userRoles';
export { sortDeliveriesByTime } from './deliverySortHelpers';

export function getRouteScopedStoreOptions(selectedDateDeliveries = [], stores = []) {
  const counts = (selectedDateDeliveries || []).reduce((acc, delivery) => {
    if (delivery?.store_id && delivery?.patient_id) acc[delivery.store_id] = (acc[delivery.store_id] || 0) + 1;
    return acc;
  }, {});

  return (stores || [])
    .filter((store) => counts[store.id])
    .sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity) || (a.name || '').localeCompare(b.name || ''))
    .map((store) => ({
      ...store,
      deliveryCount: counts[store.id] || 0,
      label: `${store.name} (${counts[store.id] || 0})`
    }));
}

export function getDriverFilterOptions({ effectiveDrivers = [], effectiveDeliveries = [], selectedDate, currentUser, driverFilter }) {
  return sortUsers(
    (effectiveDrivers || []).filter((d) => userHasRole(d, 'driver') && (() => {
      // Always include the currently selected driver so it doesn't vanish from the dropdown
      if (driverFilter !== 'all' && d.id === driverFilter) return true;
      const selectedDateString = selectedDate ? format(selectedDate, 'yyyy-MM-dd') : null;
      if (!selectedDateString) return true;
      const isDispatcher = userHasRole(currentUser, 'dispatcher') && !userHasRole(currentUser, 'admin');
      const dispatcherStoreIds = isDispatcher ? new Set(currentUser.store_ids || []) : null;
      // When viewing all drivers, include any driver who has deliveries in the full loaded dataset
      // (not just selected date) so switching drivers doesn't clear the list
      return (effectiveDeliveries || []).some((delivery) =>
        delivery &&
        (!dispatcherStoreIds || !delivery.store_id || dispatcherStoreIds.has(delivery.store_id)) &&
        ((delivery.driver_id && (delivery.driver_id === d.id || delivery.driver_id === d.appUserId)) ||
          (delivery.driver_name && (delivery.driver_name === d.full_name || delivery.driver_name === d.user_name)))
      );
    })())
  ).map((driver) => {
    const duplicateNames = (effectiveDrivers || []).filter((d) => getDriverDisplayName(d) === getDriverDisplayName(driver));
    return {
      id: driver.id,
      label: duplicateNames.length > 1 ? `${getDriverDisplayName(driver)} (${driver.id.slice(-4)})` : getDriverDisplayName(driver)
    };
  });
}


// ── Route Management search ────────────────────────────────────────────────
// Owner spec Nov 13 2026: the search box must also look inside PATIENT NOTES,
// DELIVERY NOTES and the COD amounts, and typing COD (or any of its tender
// words) must surface every COD stop — including on the Route Date cards.
const COD_SEARCH_WORDS = new Set([
  'cod', 'cods', 'cash', 'debit', 'credit', 'cheque', 'check', 'checks',
  'etransfer', 'etrans', 'etransfers', 'emt', 'etfr', 'eft'
]);

const normalizeSearchWord = (word) => String(word || '').toLowerCase().replace(/[\s\-_.]/g, '');

const isCodSearchWord = (word) => COD_SEARCH_WORDS.has(normalizeSearchWord(word));

// A delivery "has a COD" when an amount is outstanding, refunded, or a payment
// was recorded. Description-tagged COD items are not needed here: the amount
// and the payment rows are the authoritative signal.
export function deliveryHasCod(delivery) {
  if (!delivery) return false;
  const amount = Number(delivery.cod_total_amount_required) || 0;
  const refunded = Number(delivery.cod_refunded_amount) || 0;
  const payments = Array.isArray(delivery.cod_payments) ? delivery.cod_payments : [];
  return amount > 0 || refunded > 0 || payments.length > 0;
}

const amountToSearchStrings = (value) => {
  const num = Number(value);
  if (!Number.isFinite(num) || num === 0) return [];
  return [String(num), num.toFixed(2)];
};

// Everything a search term can match, as one lowercase haystack.
export function buildRouteSearchHaystack(delivery, patient, store) {
  const parts = [
    patient?.full_name,
    patient?.address,
    patient?.unit_number,
    patient?.phone,
    patient?.notes,
    delivery?.driver_name,
    delivery?.delivery_notes,
    delivery?.prescription_number,
    store?.name,
    store?.abbreviation
  ];
  amountToSearchStrings(delivery?.cod_total_amount_required).forEach((v) => parts.push(v));
  amountToSearchStrings(delivery?.cod_refunded_amount).forEach((v) => parts.push(v));
  if (Array.isArray(delivery?.cod_payments)) {
    delivery.cod_payments.forEach((payment) => {
      amountToSearchStrings(payment?.amount).forEach((v) => parts.push(v));
      if (payment?.type) parts.push(payment.type);
    });
  }
  return parts.filter(Boolean).join(' ').toLowerCase();
}

// Builds a reusable predicate so the stop list and the Route Date cards agree.
export function createRouteSearchMatcher(searchTerm, effectivePatients = [], stores = []) {
  const raw = String(searchTerm || '').trim().toLowerCase();
  if (!raw) return null;

  const tokens = raw.split(/\s+/).filter(Boolean);
  const codOnly = tokens.some(isCodSearchWord);
  const textTokens = tokens.filter((t) => !isCodSearchWord(t));

  const patientMap = new Map((effectivePatients || []).filter((p) => p?.id).map((p) => [p.id, p]));
  const storeMap = new Map((stores || []).filter((s) => s?.id).map((s) => [s.id, s]));

  return (delivery) => {
    if (!delivery) return false;
    if (codOnly && !deliveryHasCod(delivery)) return false;
    if (textTokens.length === 0) return true;
    const haystack = buildRouteSearchHaystack(
      delivery,
      patientMap.get(delivery.patient_id),
      storeMap.get(delivery.store_id)
    );
    // Multi-word terms AND together, matching the older single-term behaviour
    // for anything that is not a COD keyword.
    return textTokens.every((token) => haystack.includes(token));
  };
}

export function applyRouteToolbarFilters({ selectedDateDeliveries = [], storeFilter = 'all', statusFilter = 'all', searchTerm = '', effectivePatients = [], stores = [], sortDeliveriesByTime }) {
  let filtered = selectedDateDeliveries;

  if (storeFilter && storeFilter !== 'all') {
    filtered = filtered.filter((delivery) => delivery.store_id === storeFilter);
  }

  if (statusFilter && statusFilter !== 'all') {
    filtered = filtered.filter((delivery) => delivery.status === statusFilter);
  }

  const searchMatcher = createRouteSearchMatcher(searchTerm, effectivePatients, stores);
  if (searchMatcher) {
    filtered = filtered.filter(searchMatcher);
  }

  return sortDeliveriesByTime(filtered).map((delivery, index) => ({
    ...delivery,
    stopOrder: index + 1
  }));
}