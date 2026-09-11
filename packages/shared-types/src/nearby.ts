// ──────────────────────────────────────────────
// "Find Mechanics Nearby" — roadside assistance domain types.
//
// Shared by the user backend (which owns the request), the mechanic backend
// (which mirrors it for dispatch) and both web frontends, so there is exactly
// one definition of the request shape and its lifecycle.
// ──────────────────────────────────────────────

/** Stable identifier for a vehicle issue. Persisted, so do not rename casually. */
export type VehicleIssueKey =
  | 'engine_problem'
  | 'battery_dead'
  | 'flat_tyre'
  | 'brake_problem'
  | 'clutch_problem'
  | 'gearbox_problem'
  | 'overheating'
  | 'ac_heating'
  | 'electrical_problem'
  | 'starting_problem'
  | 'fluid_leak'
  | 'steering_problem'
  | 'suspension_problem'
  | 'fuel_problem'
  | 'accident_damage'
  | 'general_servicing'
  | 'unknown'
  | 'other';

export type VehicleIssueCategory =
  | 'Engine & Drivetrain'
  | 'Electrical'
  | 'Wheels & Brakes'
  | 'Comfort'
  | 'Body & Damage'
  | 'Maintenance'
  | 'Not sure';

export interface VehicleIssue {
  key: VehicleIssueKey;
  /** Human label shown in the picker and on both apps. */
  label: string;
  category: VehicleIssueCategory;
  icon: string;
  /** Short hint shown under the label in the picker. */
  hint: string;
  /** Search synonyms so "puncture" finds "Flat / Damaged Tyre". */
  keywords: string[];
  /** True for the "I don't know what the issue is" escape hatch. */
  requiresDiagnosis?: boolean;
}

export interface GeoLocation {
  latitude: number;
  longitude: number;
  /** Best-effort human label, e.g. "Andheri West, Mumbai". */
  label?: string | null;
  /** Metres of uncertainty, when the provider reports it. */
  accuracy?: number | null;
}

/** How a location was obtained — surfaced so the UI can be honest about it. */
export type LocationSource = 'gps' | 'mock' | 'manual';

export interface PricingEstimate {
  /** null for issues that can only be priced after diagnosis. */
  min: number | null;
  max: number | null;
  currency: string;
  /** Pre-formatted for display, e.g. "₹800 – ₹1,500". */
  display: string;
  /** True when the estimate could not be computed up front. */
  requiresDiagnosis: boolean;
  /** Itemised extras folded into the range (call-out fee, night surcharge…). */
  additionalCharges: { label: string; amount: number }[];
  note: string;
}

/**
 * Request lifecycle. The user backend is the single source of truth; the
 * mechanic backend mirrors it and reports transitions back.
 */
export type NearbyRequestStatus =
  | 'SEARCHING'
  | 'PENDING_MECHANIC_RESPONSE'
  | 'ACCEPTED'
  | 'REJECTED'
  | 'MECHANIC_ON_THE_WAY'
  | 'ARRIVED'
  | 'IN_SERVICE'
  /** Work finished. Superseded by PAYMENT_PENDING the moment the invoice exists. */
  | 'COMPLETED'
  | 'PAYMENT_PENDING'
  | 'PAYMENT_COMPLETED'
  | 'CASH_SELECTED'
  | 'RATED'
  | 'CANCELLED'
  | 'NO_MECHANIC_FOUND';

/**
 * Statuses where the request is still on screen and both apps keep polling.
 * Payment and rating are part of this: the job card stays put until the
 * customer has rated, so the whole flow happens in one window.
 */
export const ACTIVE_NEARBY_STATUSES: NearbyRequestStatus[] = [
  'SEARCHING',
  'PENDING_MECHANIC_RESPONSE',
  'ACCEPTED',
  'MECHANIC_ON_THE_WAY',
  'ARRIVED',
  'IN_SERVICE',
  'COMPLETED',
  'PAYMENT_PENDING',
  'PAYMENT_COMPLETED',
  'CASH_SELECTED',
];

/** Statuses that end the flow — nothing further will happen on its own. */
export const TERMINAL_NEARBY_STATUSES: NearbyRequestStatus[] = [
  'REJECTED',
  'RATED',
  'CANCELLED',
  'NO_MECHANIC_FOUND',
];

/** The customer still owes an action (pay, or rate) on these. */
export const AWAITING_CUSTOMER_STATUSES: NearbyRequestStatus[] = [
  'COMPLETED',
  'PAYMENT_PENDING',
  'PAYMENT_COMPLETED',
  'CASH_SELECTED',
];

export interface NearbyVehicleSnapshot {
  id: number | null;
  make: string;
  model: string;
  year: number | null;
  registrationNo: string | null;
}

export interface NearbyMechanicSnapshot {
  id: number;
  name: string;
  workshopName?: string | null;
  phone?: string | null;
  rating?: number | null;
  specialization?: string | null;
}

export interface NearbyRequest {
  id: number;
  reference: string;
  userId: number;
  userName?: string | null;
  userPhone?: string | null;
  mechanicId: number | null;
  vehicleId: number | null;
  vehicle: NearbyVehicleSnapshot;
  mechanic?: NearbyMechanicSnapshot | null;

  issueKey: VehicleIssueKey;
  issueLabel: string;
  description: string | null;

  userLocation: GeoLocation;
  mechanicLocation: GeoLocation | null;
  locationSource: LocationSource;

  /** Kilometres between mechanic and user, recomputed as the mechanic moves. */
  distanceKm: number | null;
  /** Minutes remaining. Counts down while MECHANIC_ON_THE_WAY. */
  etaMinutes: number | null;

  pricing: PricingEstimate;
  /** What the mechanic actually charged. Null until the job is completed. */
  finalAmount: number | null;
  status: NearbyRequestStatus;
  /** Set when a mechanic declines, so the user can be told why. */
  rejectionReason?: string | null;

  /** Present from completion onwards. Drives the payment step. */
  payment?: NearbyPayment | null;
  /** Present once the customer has rated. Its existence blocks a second rating. */
  rating?: NearbyRating | null;

  createdAt: string;
  updatedAt: string;
  acceptedAt?: string | null;
  respondedAt?: string | null;
  completedAt?: string | null;
}

/** Payload the user app sends to open a request. */
export interface CreateNearbyRequestPayload {
  vehicleId: number;
  issueKey: VehicleIssueKey;
  description?: string | null;
  userLocation: GeoLocation;
  locationSource?: LocationSource;
}

/* ── Payment ─────────────────────────────────── */

export type PaymentMethod = 'ONLINE' | 'CASH';

/**
 * CASH_SELECTED is deliberately distinct from PAID: the customer has told us
 * how they will settle up, but nothing has been digitally verified.
 */
export type PaymentStatus = 'PENDING' | 'PAID' | 'CASH_SELECTED' | 'FAILED';

export interface NearbyPayment {
  id: number;
  requestId: number;
  userId: number;
  mechanicId: number | null;
  amount: number;
  currency: string;
  method: PaymentMethod | null;
  status: PaymentStatus;
  /** Gateway reference. Generated by the payment adapter, never by the UI. */
  transactionId: string | null;
  failureReason?: string | null;
  attempts: number;
  createdAt: string;
  updatedAt: string;
}

/* ── Rating ──────────────────────────────────── */

export interface NearbyRating {
  id: number;
  requestId: number;
  userId: number;
  userName?: string | null;
  mechanicId: number;
  rating: number; // 1..5
  review: string | null;
  createdAt: string;
}

export interface RatingSummary {
  /** null when the mechanic has no ratings at all. */
  average: number | null;
  total: number;
  /** Counts keyed 1..5. Always present, zeroed when empty. */
  distribution: Record<1 | 2 | 3 | 4 | 5, number>;
}

export interface MechanicRatingsResponse extends RatingSummary {
  reviews: NearbyRating[];
}
