// ──────────────────────────────────────────────
// "Find Mechanics Nearby" — issue catalogue, pricing engine and geo helpers.
//
// Everything the roadside-assistance flow needs to *decide* something lives
// here rather than in a component, so the same numbers are used by the user
// app, the mechanic app and both backends. Swapping in a backend pricing
// service later means reimplementing getEstimatedPrice, nothing else.
// ──────────────────────────────────────────────
import type {
  GeoLocation,
  PricingEstimate,
  VehicleIssue,
  VehicleIssueKey,
} from '@automate/shared-types';
import { formatCurrency } from './index';

/* ── Issue catalogue ─────────────────────────── */

export const VEHICLE_ISSUES: VehicleIssue[] = [
  { key: 'engine_problem', label: 'Engine Problem', category: 'Engine & Drivetrain', icon: '🔧', hint: 'Misfiring, knocking, loss of power', keywords: ['engine', 'misfire', 'knocking', 'power', 'noise'] },
  { key: 'overheating', label: 'Engine Overheating', category: 'Engine & Drivetrain', icon: '🌡️', hint: 'Temperature warning, steam, coolant loss', keywords: ['overheat', 'temperature', 'coolant', 'radiator', 'steam'] },
  { key: 'clutch_problem', label: 'Clutch Problem', category: 'Engine & Drivetrain', icon: '⚙️', hint: 'Slipping, hard pedal, burning smell', keywords: ['clutch', 'slipping', 'pedal', 'burning'] },
  { key: 'gearbox_problem', label: 'Gearbox / Transmission Problem', category: 'Engine & Drivetrain', icon: '🔩', hint: 'Hard shifting, grinding, stuck in gear', keywords: ['gear', 'gearbox', 'transmission', 'shift', 'grinding'] },
  { key: 'starting_problem', label: 'Starting Problem', category: 'Electrical', icon: '🔑', hint: 'Cranks but will not start, no response', keywords: ['start', 'starter', 'crank', 'ignition', 'not starting'] },
  { key: 'battery_dead', label: 'Battery Dead', category: 'Electrical', icon: '🔋', hint: 'No power, needs a jump start', keywords: ['battery', 'jump', 'dead', 'power', 'flat battery'] },
  { key: 'electrical_problem', label: 'Electrical Problem', category: 'Electrical', icon: '💡', hint: 'Lights, wiring, warning lamps, fuses', keywords: ['electrical', 'wiring', 'lights', 'fuse', 'warning'] },
  { key: 'flat_tyre', label: 'Flat / Damaged Tyre', category: 'Wheels & Brakes', icon: '🛞', hint: 'Puncture, blowout, spare fitting', keywords: ['tyre', 'tire', 'puncture', 'flat', 'wheel', 'blowout'] },
  { key: 'brake_problem', label: 'Brake Problem', category: 'Wheels & Brakes', icon: '🛑', hint: 'Squealing, soft pedal, poor stopping', keywords: ['brake', 'pads', 'squeal', 'stopping', 'disc'] },
  { key: 'suspension_problem', label: 'Suspension Problem', category: 'Wheels & Brakes', icon: '🪫', hint: 'Knocking over bumps, bouncy ride', keywords: ['suspension', 'shocker', 'strut', 'bumpy', 'knocking'] },
  { key: 'steering_problem', label: 'Steering Problem', category: 'Wheels & Brakes', icon: '🎯', hint: 'Pulling, vibration, heavy steering', keywords: ['steering', 'wheel', 'pulling', 'vibration', 'alignment'] },
  { key: 'ac_heating', label: 'AC / Heating Problem', category: 'Comfort', icon: '❄️', hint: 'Not cooling, bad smell, weak airflow', keywords: ['ac', 'air conditioning', 'cooling', 'heater', 'blower'] },
  { key: 'fluid_leak', label: 'Oil / Fluid Leakage', category: 'Maintenance', icon: '🛢️', hint: 'Puddle under the car, dropping levels', keywords: ['oil', 'leak', 'fluid', 'coolant', 'puddle'] },
  { key: 'fuel_problem', label: 'Fuel Problem', category: 'Maintenance', icon: '⛽', hint: 'Ran out, wrong fuel, fuel pump trouble', keywords: ['fuel', 'petrol', 'diesel', 'empty', 'pump'] },
  { key: 'general_servicing', label: 'General Servicing', category: 'Maintenance', icon: '🧰', hint: 'Routine service and inspection', keywords: ['service', 'servicing', 'maintenance', 'checkup'] },
  { key: 'accident_damage', label: 'Accident / Damage', category: 'Body & Damage', icon: '🚨', hint: 'Collision damage, needs assessment', keywords: ['accident', 'crash', 'damage', 'collision', 'dent'] },
  { key: 'unknown', label: 'Unknown / Need Diagnosis', category: 'Not sure', icon: '❓', hint: "I don't know what the issue is", keywords: ['unknown', 'not sure', 'diagnosis', 'dont know', 'help'], requiresDiagnosis: true },
  { key: 'other', label: 'Other', category: 'Not sure', icon: '📝', hint: 'Something else — describe it below', keywords: ['other', 'misc'] },
];

const ISSUE_BY_KEY: Record<string, VehicleIssue> = Object.fromEntries(
  VEHICLE_ISSUES.map((i) => [i.key, i]),
);

export function getIssue(key: VehicleIssueKey | string): VehicleIssue | undefined {
  return ISSUE_BY_KEY[key];
}

export function issueLabel(key: VehicleIssueKey | string): string {
  return ISSUE_BY_KEY[key]?.label ?? 'Unknown / Need Diagnosis';
}

/** Substring + synonym search used by the picker's search box. */
export function searchIssues(query: string): VehicleIssue[] {
  const q = query.trim().toLowerCase();
  if (!q) return VEHICLE_ISSUES;
  return VEHICLE_ISSUES.filter((i) =>
    `${i.label} ${i.category} ${i.hint} ${i.keywords.join(' ')}`.toLowerCase().includes(q),
  );
}

/* ── Pricing engine ──────────────────────────── */

export interface IssuePricing {
  basePrice: number;
  minPrice: number;
  maxPrice: number;
  /** Priced only after a mechanic inspects the vehicle. */
  diagnosisOnly?: boolean;
}

/**
 * Indicative on-site roadside rates in INR. Tune here, never in a component.
 * A backend pricing service would return exactly this shape.
 */
export const PRICING_TABLE: Record<VehicleIssueKey, IssuePricing> = {
  engine_problem: { basePrice: 1500, minPrice: 1500, maxPrice: 5000 },
  overheating: { basePrice: 900, minPrice: 900, maxPrice: 2500 },
  clutch_problem: { basePrice: 2000, minPrice: 2000, maxPrice: 6000 },
  gearbox_problem: { basePrice: 2500, minPrice: 2500, maxPrice: 8000 },
  starting_problem: { basePrice: 600, minPrice: 600, maxPrice: 1800 },
  battery_dead: { basePrice: 500, minPrice: 500, maxPrice: 1200 },
  electrical_problem: { basePrice: 700, minPrice: 700, maxPrice: 2500 },
  flat_tyre: { basePrice: 300, minPrice: 300, maxPrice: 800 },
  brake_problem: { basePrice: 800, minPrice: 800, maxPrice: 2000 },
  suspension_problem: { basePrice: 1200, minPrice: 1200, maxPrice: 4000 },
  steering_problem: { basePrice: 900, minPrice: 900, maxPrice: 3000 },
  ac_heating: { basePrice: 800, minPrice: 800, maxPrice: 2500 },
  fluid_leak: { basePrice: 600, minPrice: 600, maxPrice: 2200 },
  fuel_problem: { basePrice: 400, minPrice: 400, maxPrice: 1500 },
  general_servicing: { basePrice: 1000, minPrice: 1000, maxPrice: 3000 },
  accident_damage: { basePrice: 2500, minPrice: 2500, maxPrice: 12000 },
  unknown: { basePrice: 0, minPrice: 0, maxPrice: 0, diagnosisOnly: true },
  other: { basePrice: 0, minPrice: 0, maxPrice: 0, diagnosisOnly: true },
};

export const PRICING_CONFIG = {
  currency: 'INR',
  /** Flat roadside call-out fee added to every priced job. */
  calloutFee: 199,
  /** Added per km beyond the free radius. */
  perKmBeyondFreeRadius: 12,
  freeRadiusKm: 5,
  /** Share of the customer price the mechanic keeps. */
  mechanicPayoutRate: 0.78,
  /** Older vehicles cost a little more to work on. */
  vehicleAgeSurchargeYears: 10,
  vehicleAgeSurchargeRate: 0.1,
} as const;

export interface PricingInputs {
  issueKey: VehicleIssueKey | string;
  vehicleYear?: number | null;
  distanceKm?: number | null;
}

/** Round to the nearest ₹50 so estimates read like quotes, not calculations. */
const roundTo50 = (n: number) => Math.round(n / 50) * 50;

/**
 * The single entry point for "what will this cost?".
 * Deliberately pure so both backends and both frontends can call it.
 */
export function getEstimatedPrice({
  issueKey,
  vehicleYear,
  distanceKm,
}: PricingInputs): PricingEstimate {
  const pricing = PRICING_TABLE[issueKey as VehicleIssueKey];
  const currency = PRICING_CONFIG.currency;

  if (!pricing || pricing.diagnosisOnly) {
    return {
      min: null,
      max: null,
      currency,
      display: 'To be determined after diagnosis',
      requiresDiagnosis: true,
      additionalCharges: [
        { label: 'Call-out & diagnosis', amount: PRICING_CONFIG.calloutFee },
      ],
      note: 'The mechanic will inspect the vehicle on site and share a firm quote before starting any work.',
    };
  }

  const additionalCharges: { label: string; amount: number }[] = [
    { label: 'Roadside call-out', amount: PRICING_CONFIG.calloutFee },
  ];

  let extra = PRICING_CONFIG.calloutFee;

  const beyond = Math.max(0, (distanceKm ?? 0) - PRICING_CONFIG.freeRadiusKm);
  if (beyond > 0) {
    const travel = roundTo50(beyond * PRICING_CONFIG.perKmBeyondFreeRadius);
    if (travel > 0) {
      additionalCharges.push({ label: `Travel beyond ${PRICING_CONFIG.freeRadiusKm} km`, amount: travel });
      extra += travel;
    }
  }

  const age = vehicleYear ? new Date().getFullYear() - vehicleYear : 0;
  let ageMultiplier = 1;
  if (age >= PRICING_CONFIG.vehicleAgeSurchargeYears) {
    ageMultiplier = 1 + PRICING_CONFIG.vehicleAgeSurchargeRate;
    additionalCharges.push({
      label: `Vehicle age (${age} yrs)`,
      amount: roundTo50(pricing.basePrice * PRICING_CONFIG.vehicleAgeSurchargeRate),
    });
  }

  const min = roundTo50(pricing.minPrice * ageMultiplier + extra);
  const max = roundTo50(pricing.maxPrice * ageMultiplier + extra);

  return {
    min,
    max,
    currency,
    display: `${formatCurrency(min, currency)} – ${formatCurrency(max, currency)}`,
    requiresDiagnosis: false,
    additionalCharges,
    note: 'Initial estimate only — parts and labour are confirmed after inspection.',
  };
}

/** What the mechanic can expect to keep, shown on the mechanic app. */
export function getMechanicPayout(estimate: PricingEstimate): {
  min: number | null;
  max: number | null;
  display: string;
} {
  if (estimate.requiresDiagnosis || estimate.min == null || estimate.max == null) {
    return { min: null, max: null, display: 'After diagnosis' };
  }
  const min = roundTo50(estimate.min * PRICING_CONFIG.mechanicPayoutRate);
  const max = roundTo50(estimate.max * PRICING_CONFIG.mechanicPayoutRate);
  return {
    min,
    max,
    display: `${formatCurrency(min, estimate.currency)} – ${formatCurrency(max, estimate.currency)}`,
  };
}

/* ── Distance & ETA ──────────────────────────── */

export const ETA_CONFIG = {
  /** Average city driving speed used to turn distance into minutes. */
  averageSpeedKmph: 22,
  /** Fixed minutes for the mechanic to pack up and set off. */
  dispatchOverheadMinutes: 3,
  minimumEtaMinutes: 2,
  /** Straight-line distance under-reports real roads; scale it up. */
  roadWindingFactor: 1.3,
} as const;

const EARTH_RADIUS_KM = 6371;
const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance in kilometres, scaled for real road routing. */
export function calculateDistance(
  from: GeoLocation | null | undefined,
  to: GeoLocation | null | undefined,
  { asTheCrowFlies = false }: { asTheCrowFlies?: boolean } = {},
): number | null {
  if (!from || !to) return null;
  const dLat = toRad(to.latitude - from.latitude);
  const dLon = toRad(to.longitude - from.longitude);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(from.latitude)) * Math.cos(toRad(to.latitude)) * Math.sin(dLon / 2) ** 2;
  const straight = EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const km = asTheCrowFlies ? straight : straight * ETA_CONFIG.roadWindingFactor;
  return Math.round(km * 10) / 10;
}

/** Minutes to cover `distanceKm`, including dispatch overhead. */
export function calculateETA(
  distanceKm: number | null | undefined,
  speedKmph: number = ETA_CONFIG.averageSpeedKmph,
): number | null {
  if (distanceKm == null || !Number.isFinite(distanceKm)) return null;
  const travel = (distanceKm / speedKmph) * 60;
  return Math.max(
    ETA_CONFIG.minimumEtaMinutes,
    Math.round(travel + ETA_CONFIG.dispatchOverheadMinutes),
  );
}

export function formatDistance(km: number | null | undefined): string {
  if (km == null) return '—';
  return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`;
}

export function formatEta(minutes: number | null | undefined): string {
  if (minutes == null) return '—';
  if (minutes <= 0) return 'Arriving now';
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

/**
 * Fraction of the journey completed, used to animate the mechanic marker and
 * the progress ring. Derived from ETA rather than stored, so every client
 * agrees without extra round trips.
 */
export function journeyProgress(
  totalEtaMinutes: number | null | undefined,
  remainingMinutes: number | null | undefined,
): number {
  if (!totalEtaMinutes || remainingMinutes == null) return 0;
  const done = (totalEtaMinutes - remainingMinutes) / totalEtaMinutes;
  return Math.min(1, Math.max(0, done));
}

/* ── POC location provider ───────────────────── */

/**
 * Every fake coordinate in the POC comes from here. Replacing the mock with a
 * real GPS/dispatch feed means changing this block and nothing else.
 */
export const MOCK_LOCATION_CONFIG = {
  /** Used when the browser denies or cannot provide a position. */
  fallbackUserLocation: {
    latitude: 19.1197,
    longitude: 72.8464,
    label: 'Andheri East, Mumbai',
  } as GeoLocation,
  /** How far a dispatched mechanic starts from the customer. */
  mechanicMinKm: 2.5,
  mechanicMaxKm: 7.5,
  /**
   * Simulated ETA countdown multiplier: 1 = real time, 12 = a 12-minute ETA
   * plays out over ~1 real minute so the flow is watchable in a demo.
   */
  etaSpeedup: 12,
} as const;

/** Deterministic 0..1 from an integer seed — same request, same position. */
function seededUnit(seed: number, salt: number): number {
  const x = Math.sin(seed * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Places a mechanic on a deterministic bearing and distance from the customer.
 * Deterministic so the marker does not jump between polls.
 */
export function mockMechanicLocationNear(
  user: GeoLocation,
  seed: number,
  label?: string | null,
): GeoLocation {
  const { mechanicMinKm, mechanicMaxKm } = MOCK_LOCATION_CONFIG;
  const km = mechanicMinKm + seededUnit(seed, 1) * (mechanicMaxKm - mechanicMinKm);
  const bearing = seededUnit(seed, 2) * 2 * Math.PI;

  // ~111 km per degree of latitude; longitude shrinks with the cosine of lat.
  const dLat = (km * Math.cos(bearing)) / 111;
  const dLng = (km * Math.sin(bearing)) / (111 * Math.cos(toRad(user.latitude)) || 1);

  return {
    latitude: Math.round((user.latitude + dLat) * 1e6) / 1e6,
    longitude: Math.round((user.longitude + dLng) * 1e6) / 1e6,
    label: label ?? null,
  };
}

/**
 * Interpolates the mechanic's position along the straight line to the customer
 * for a given journey progress (0..1). Stands in for a live GPS feed.
 */
export function interpolateLocation(
  from: GeoLocation,
  to: GeoLocation,
  progress: number,
): GeoLocation {
  const t = Math.min(1, Math.max(0, progress));
  return {
    latitude: Math.round((from.latitude + (to.latitude - from.latitude) * t) * 1e6) / 1e6,
    longitude: Math.round((from.longitude + (to.longitude - from.longitude) * t) * 1e6) / 1e6,
    label: from.label ?? null,
  };
}

/* ── Ratings ─────────────────────────────────── */

/**
 * Derives a mechanic's headline rating from the rating records themselves.
 * Nothing stores a permanent average — recomputing keeps the profile honest
 * as reviews arrive. If this ever gets slow, cache the result of THIS
 * function rather than denormalising the number into the mechanics row.
 */
export function summariseRatings(
  ratings: Array<{ rating: number }>,
): { average: number | null; total: number; distribution: Record<1 | 2 | 3 | 4 | 5, number> } {
  const distribution: Record<1 | 2 | 3 | 4 | 5, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let sum = 0;

  for (const r of ratings) {
    const star = Math.round(r.rating);
    if (star >= 1 && star <= 5) {
      distribution[star as 1 | 2 | 3 | 4 | 5] += 1;
      sum += r.rating;
    }
  }

  const total = ratings.length;
  return {
    average: total ? Math.round((sum / total) * 10) / 10 : null,
    total,
    distribution,
  };
}

/** Share of the total each star band holds, for the breakdown bars. */
export function ratingShare(
  distribution: Record<1 | 2 | 3 | 4 | 5, number>,
  star: 1 | 2 | 3 | 4 | 5,
): number {
  const total = Object.values(distribution).reduce((a, b) => a + b, 0);
  return total ? distribution[star] / total : 0;
}
