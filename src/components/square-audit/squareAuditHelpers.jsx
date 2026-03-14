import { format, subDays } from "date-fns";

export const LOOKBACK_DAYS = 14;

export function getAuditRange() {
  const end = new Date();
  const start = subDays(end, LOOKBACK_DAYS);
  return {
    start,
    end,
    startDate: format(start, "yyyy-MM-dd"),
    endDate: format(end, "yyyy-MM-dd"),
  };
}

export function normalizeDate(value) {
  if (!value) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return String(value);
  return String(value).slice(0, 10);
}

export function toAmountCents(value) {
  const num = Number(value || 0);
  if (!Number.isFinite(num)) return 0;
  return Math.round(num * 100);
}

export function formatCurrencyFromCents(amountCents) {
  return `$${(Number(amountCents || 0) / 100).toFixed(2)}`;
}

export function parseSquareItemName(itemName) {
  const value = String(itemName || "").trim();
  if (!value) return null;

  const dateMatch = value.match(/^(\d{2})[\/-](\d{2})/);
  const storeMatch = value.match(/\(([A-Za-z0-9]{2})\)/);
  const patientMatch = value.match(/\)-(.+)$/);

  if (!dateMatch) return null;

  const currentYear = new Date().getFullYear();
  const deliveryDate = `${currentYear}-${dateMatch[1]}-${dateMatch[2]}`;

  return {
    delivery_date: deliveryDate,
    store_abbreviation: storeMatch ? storeMatch[1].toUpperCase() : "",
    patient_name: patientMatch ? patientMatch[1].trim() : "",
  };
}

export function buildStoreMaps(stores, locationConfigs) {
  const configById = new Map((locationConfigs || []).map((config) => [config.id, config]));
  const storeById = new Map((stores || []).map((store) => [store.id, store]));
  const storeByLocationId = new Map();
  const locationIdByStoreId = new Map();
  const storeByAbbreviation = new Map();

  for (const store of stores || []) {
    if (store?.abbreviation) {
      storeByAbbreviation.set(String(store.abbreviation).toUpperCase(), store);
    }
    if (store?.square_location_config_id) {
      const config = configById.get(store.square_location_config_id);
      if (config?.square_location_id) {
        locationIdByStoreId.set(store.id, config.square_location_id);
        storeByLocationId.set(config.square_location_id, store);
      }
    }
  }

  return {
    configById,
    storeById,
    storeByLocationId,
    locationIdByStoreId,
    storeByAbbreviation,
  };
}

export function buildAuditKey(row) {
  return `${row.date || "na"}__${row.locationId || "na"}__${row.amountCents || 0}`;
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function compareAgainst(row, otherRows, otherLabel) {
  if (!otherRows.length) return [`Missing in ${otherLabel}`];

  const exact = otherRows.some(
    (other) =>
      other.date === row.date &&
      other.locationId === row.locationId &&
      other.amountCents === row.amountCents,
  );
  if (exact) return [];

  const issues = [];

  const sameDateAndLocation = otherRows.some(
    (other) => other.date === row.date && other.locationId === row.locationId,
  );
  const sameDateAndAmount = otherRows.some(
    (other) => other.date === row.date && other.amountCents === row.amountCents,
  );
  const sameLocationAndAmount = otherRows.some(
    (other) => other.locationId === row.locationId && other.amountCents === row.amountCents,
  );

  if (sameDateAndLocation) issues.push(`Amount vs ${otherLabel}`);
  if (sameDateAndAmount) issues.push(`Store vs ${otherLabel}`);
  if (sameLocationAndAmount) issues.push(`Date vs ${otherLabel}`);
  if (!issues.length) issues.push(`Missing in ${otherLabel}`);

  return issues;
}

export function attachDiscrepancies(rows, comparisons) {
  return (rows || []).map((row) => {
    const issues = unique(
      comparisons.flatMap((comparison) => compareAgainst(row, comparison.rows || [], comparison.label)),
    );

    return {
      ...row,
      auditKey: buildAuditKey(row),
      issues,
      hasDiscrepancy: issues.length > 0,
    };
  });
}

function escapeCsvValue(value) {
  const stringValue = String(value ?? "");
  if (/[",\n]/.test(stringValue)) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }
  return stringValue;
}

export function downloadAuditCsv(sections, fileName = "square-cod-audit.csv") {
  const lines = [];

  for (const section of sections) {
    lines.push(section.title);
    lines.push(section.headers.join(","));
    for (const row of section.rows) {
      lines.push(row.map(escapeCsvValue).join(","));
    }
    lines.push("");
  }

  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}