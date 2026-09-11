// ──────────────────────────────────────────────
// Vehicle helpers shared by both backends and every frontend.
//
// Deliberately pure and free of vehicle-type assumptions: the same functions
// format a scooter, a tractor and an electric bus. Anything that varies per
// vehicle type (registration format, icon, label) comes from master data that
// is passed in, never from a table baked into this file.
// ──────────────────────────────────────────────
import type { RegistrationRule, Vehicle } from '@automate/shared-types';

/**
 * Fallback used when the API has no rule for a type/category, and by the
 * backend when the registration-rule table is empty. Deliberately permissive:
 * an unknown vehicle type must never be blocked by a car-shaped format.
 */
export const DEFAULT_REGISTRATION_RULE: RegistrationRule = {
  id: 0,
  vehicleTypeId: null,
  vehicleCategoryId: null,
  pattern: '^[A-Z0-9-]{4,20}$',
  placeholder: 'MH12AB1234',
  helpText: 'Letters, digits and hyphens — as printed on the registration plate.',
  minLength: 4,
  maxLength: 20,
  isRequired: true,
};

/** Registration numbers are stored uppercase with spaces and dots removed. */
export function normalizeRegistrationNo(value: string): string {
  return String(value ?? '')
    .toUpperCase()
    .replace(/[\s.]+/g, '')
    .trim();
}

/**
 * Picks the rule that applies to a selection. A category rule beats a type
 * rule, which beats the global rule — so "Tractor" can override "Four Wheeler"
 * without either of them knowing about the other.
 */
export function resolveRegistrationRule(
  rules: RegistrationRule[] | null | undefined,
  selection: { vehicleTypeId?: number | null; vehicleCategoryId?: number | null },
): RegistrationRule {
  const list = rules ?? [];
  const byCategory =
    selection.vehicleCategoryId != null
      ? list.find((r) => r.vehicleCategoryId === selection.vehicleCategoryId)
      : undefined;
  if (byCategory) return byCategory;

  const byType =
    selection.vehicleTypeId != null
      ? list.find((r) => r.vehicleCategoryId == null && r.vehicleTypeId === selection.vehicleTypeId)
      : undefined;
  if (byType) return byType;

  return list.find((r) => r.vehicleTypeId == null && r.vehicleCategoryId == null) ?? DEFAULT_REGISTRATION_RULE;
}

/** `null` when the value is acceptable, otherwise a message to show the user. */
export function validateRegistrationNo(
  raw: string,
  rule: RegistrationRule = DEFAULT_REGISTRATION_RULE,
): string | null {
  const value = normalizeRegistrationNo(raw);
  if (!value) return rule.isRequired ? 'Enter the registration number' : null;
  if (value.length < rule.minLength)
    return `Registration number must be at least ${rule.minLength} characters`;
  if (value.length > rule.maxLength)
    return `Registration number must be at most ${rule.maxLength} characters`;
  if (rule.pattern) {
    let re: RegExp;
    try {
      re = new RegExp(rule.pattern, 'i');
    } catch {
      // A malformed pattern in master data must not block the user.
      return null;
    }
    if (!re.test(value)) {
      return rule.helpText
        ? `That does not look right. ${rule.helpText}`
        : 'That does not look like a valid registration number';
    }
  }
  return null;
}

/** Bounds for the manufacturing-year field, shared by web and mobile. */
export const MIN_VEHICLE_YEAR = 1950;
export const maxVehicleYear = () => new Date().getFullYear() + 1;

export function validateVehicleYear(value: number | string | null | undefined): string | null {
  const year = Number(value);
  if (!value && value !== 0) return 'Enter the manufacturing year';
  if (!Number.isInteger(year) || year < MIN_VEHICLE_YEAR || year > maxVehicleYear())
    return `Year must be between ${MIN_VEHICLE_YEAR} and ${maxVehicleYear()}`;
  return null;
}

/** Anything vehicle-shaped: a garage row, or a service request that joined one. */
type VehicleLike = Partial<Vehicle>;

/** "Honda Activa" — falls back through custom text and legacy columns. */
export function vehicleDisplayName(v: VehicleLike | null | undefined): string {
  if (!v) return 'Vehicle';
  const brand = v.manufacturerName || v.customManufacturer || v.make || '';
  const model = v.modelName || v.customModel || v.model || '';
  const name = [brand, model].filter(Boolean).join(' ').trim();
  return name || v.nickname || v.registrationNo || 'Vehicle';
}

/** "Scooter · Petrol · 2021" — only the parts that are actually known. */
export function vehicleSubtitle(v: VehicleLike | null | undefined): string {
  if (!v) return '';
  return [
    v.vehicleCategoryName,
    v.variantName || v.customVariant,
    v.fuelTypeName,
    v.year ? String(v.year) : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** "Honda Activa · MH12AB1234" — the one-liner used in pickers and summaries. */
export function vehicleOptionLabel(v: VehicleLike | null | undefined): string {
  if (!v) return '';
  const reg = v.registrationNo ? ` · ${v.registrationNo}` : '';
  return `${vehicleDisplayName(v)}${reg}`;
}

/**
 * Emoji for a vehicle. Master data supplies the icon; this is only the
 * last-resort fallback so a brand-new category added tonight still renders.
 */
export function vehicleIcon(v: VehicleLike | null | undefined): string {
  return v?.vehicleCategoryIcon || (v?.isElectric ? '⚡' : '🚗');
}
