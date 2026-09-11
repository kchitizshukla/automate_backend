// ──────────────────────────────────────────────
// "Find Mechanics Nearby" — user side.
//
// The user module owns the request row. Dispatch to a mechanic goes through
// `assignMechanic()` + `dispatchToMechanicModule()`, which are the only two
// places that know a mechanic is picked by configuration rather than by real
// proximity matching. Replacing the POC assignment means rewriting
// assignMechanic() and nothing else.
// ──────────────────────────────────────────────
import { Router, type Request, type Response, type NextFunction } from 'express';
import {
  calculateDistance,
  calculateETA,
  getEstimatedPrice,
  issueLabel,
  getIssue,
  mockMechanicLocationNear,
  interpolateLocation,
  journeyProgress,
  MOCK_LOCATION_CONFIG,
  VEHICLE_ISSUES,
  PRICING_CONFIG,
  ETA_CONFIG,
} from '@automate/shared-utils';
import { ACTIVE_NEARBY_STATUSES } from '@automate/shared-types';
import type {
  GeoLocation,
  NearbyPayment,
  NearbyRating,
  NearbyRequest,
  NearbyRequestStatus,
  PricingEstimate,
} from '@automate/shared-types';
import { paymentGateway, PAYMENT_CONFIG } from './payments.js';
import { db } from './db.js';
import { requireAuth, type AuthedRequest } from './auth.js';
import { logAction, notify } from './middleware.js';

const h =
  (fn: (req: any, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

export const nearbyRouter = Router();

/* ── POC configuration ───────────────────────── */

export const NEARBY_CONFIG = {
  /** The mechanic every POC request is routed to. Swap for real matching. */
  pocMechanicId: Number(process.env.POC_MECHANIC_ID) || 1,
  /** Base URL of the mechanic module, used for server-to-server dispatch. */
  mechanicApiUrl: process.env.MECHANIC_INTERNAL_API || 'http://localhost:4002/api',
  /** Shared secret for the internal endpoints both modules expose. */
  dispatchSecret: process.env.INTERNAL_DISPATCH_SECRET || 'automate_internal_dispatch',
  /** How fast the simulated ETA counts down (1 = real time). */
  etaSpeedup: Number(process.env.ETA_SIMULATION_SPEEDUP) || MOCK_LOCATION_CONFIG.etaSpeedup,
  /** A request nobody answers within this long is abandoned. */
  mechanicResponseTimeoutSeconds: Number(process.env.MECHANIC_RESPONSE_TIMEOUT) || 120,
} as const;

/* ── Row mapping ─────────────────────────────── */

const num = (v: any): number | null => (v == null ? null : Number(v));

const sqlList = (values: readonly string[]) => values.map((v) => `'${v}'`).join(',');

/** Everything the tracker keeps on screen, including the payment/rating tail. */
const ACTIVE_SQL = sqlList(ACTIVE_NEARBY_STATUSES);

/**
 * What blocks a second request. Narrower than ACTIVE on purpose: once the
 * customer has paid or chosen cash, an unrated job must not stop them
 * raising a fresh breakdown. Mirrors idx_nearby_requests_one_active.
 */
const BLOCKING_SQL = sqlList([
  'SEARCHING', 'PENDING_MECHANIC_RESPONSE', 'ACCEPTED',
  'MECHANIC_ON_THE_WAY', 'ARRIVED', 'IN_SERVICE', 'PAYMENT_PENDING',
]);

function pricingFromRow(row: any): PricingEstimate {
  // Re-derive so the wording and surcharge breakdown always match the current
  // pricing config; the stored min/max stay authoritative for the amounts.
  const derived = getEstimatedPrice({
    issueKey: row.issue_key,
    vehicleYear: num(row.vehicle_year),
    distanceKm: num(row.distance_km),
  });
  if (row.price_requires_diagnosis) return derived;
  return {
    ...derived,
    min: num(row.price_min),
    max: num(row.price_max),
    display: derived.display,
    currency: row.price_currency ?? PRICING_CONFIG.currency,
  };
}

function userLocationOf(row: any): GeoLocation {
  return {
    latitude: Number(row.user_lat),
    longitude: Number(row.user_lng),
    label: row.user_location_label ?? null,
  };
}

function mechanicLocationOf(row: any): GeoLocation | null {
  if (row.mechanic_lat == null || row.mechanic_lng == null) return null;
  return {
    latitude: Number(row.mechanic_lat),
    longitude: Number(row.mechanic_lng),
    label: row.mechanic_location_label ?? null,
  };
}

/**
 * Live ETA. Derived from `accepted_at` + `initial_eta_minutes` rather than a
 * background timer, so every poll from every client agrees and nothing drifts
 * if the process restarts. `etaSpeedup` makes the countdown watchable.
 */
function liveEta(row: any): { etaMinutes: number | null; arrived: boolean } {
  const initial = num(row.initial_eta_minutes) ?? num(row.eta_minutes);
  if (initial == null || !row.accepted_at) {
    return { etaMinutes: num(row.eta_minutes), arrived: false };
  }
  const elapsedMin =
    ((Date.now() - new Date(row.accepted_at).getTime()) / 60000) * NEARBY_CONFIG.etaSpeedup;
  const remaining = Math.max(0, Math.ceil(initial - elapsedMin));
  return { etaMinutes: remaining, arrived: remaining <= 0 };
}

function rowToRequest(
  row: any,
  mechanic?: any,
  payment?: any,
  rating?: any,
): NearbyRequest {
  const { etaMinutes } = liveEta(row);
  const initial = num(row.initial_eta_minutes);
  const userLocation = userLocationOf(row);
  const startLocation = mechanicLocationOf(row);

  // While en route, walk the mechanic marker along the line to the customer.
  const progress = journeyProgress(initial, etaMinutes);
  const enRoute = row.status === 'MECHANIC_ON_THE_WAY' || row.status === 'ARRIVED';
  const mechanicLocation =
    enRoute && startLocation ? interpolateLocation(startLocation, userLocation, progress) : startLocation;

  const distanceKm =
    enRoute && mechanicLocation
      ? calculateDistance(mechanicLocation, userLocation)
      : num(row.distance_km);

  return {
    id: row.id,
    reference: row.reference,
    userId: row.user_id,
    mechanicId: num(row.mechanic_id),
    vehicleId: num(row.vehicle_id),
    vehicle: {
      id: num(row.vehicle_id),
      make: row.vehicle_make ?? '',
      model: row.vehicle_model ?? '',
      year: num(row.vehicle_year),
      registrationNo: row.vehicle_reg_no ?? null,
    },
    mechanic: mechanic
      ? {
          id: mechanic.id,
          name: mechanic.name,
          workshopName: mechanic.workshop_name ?? null,
          rating: num(mechanic.rating),
          specialization: mechanic.specialization ?? null,
        }
      : null,
    issueKey: row.issue_key,
    issueLabel: row.issue_label,
    description: row.description ?? null,
    userLocation,
    mechanicLocation,
    locationSource: row.location_source,
    distanceKm,
    etaMinutes,
    pricing: pricingFromRow(row),
    finalAmount: num(row.final_amount),
    status: row.status,
    rejectionReason: row.rejection_reason ?? null,
    payment: payment ? paymentToDto(payment) : null,
    rating: rating ? ratingToDto(rating) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    acceptedAt: row.accepted_at ?? null,
    respondedAt: row.responded_at ?? null,
    completedAt: row.completed_at ?? null,
  };
}

function paymentToDto(row: any): NearbyPayment {
  return {
    id: row.id,
    requestId: row.request_id,
    userId: row.user_id,
    mechanicId: num(row.mechanic_id),
    amount: Number(row.amount),
    currency: PAYMENT_CONFIG.currency,
    method: row.method ?? null,
    status: row.status,
    transactionId: row.transaction_id ?? null,
    failureReason: row.failure_reason ?? null,
    attempts: row.attempts ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function ratingToDto(row: any): NearbyRating {
  return {
    id: row.id,
    requestId: row.request_id,
    userId: row.user_id,
    userName: row.user_name ?? null,
    mechanicId: row.mechanic_id,
    rating: Number(row.rating),
    review: row.review ?? null,
    createdAt: row.created_at,
  };
}

const loadPayment = (requestId: number) =>
  db.prepare('SELECT * FROM nearby_payments WHERE request_id=?').get(requestId);
const loadRating = (requestId: number) =>
  db.prepare('SELECT * FROM nearby_ratings WHERE request_id=?').get(requestId);

/** Assembles the full DTO: request + mechanic + payment + rating. */
async function hydrate(row: any): Promise<NearbyRequest> {
  const [mechanic, payment, rating] = await Promise.all([
    loadMechanic(num(row.mechanic_id)),
    loadPayment(row.id),
    loadRating(row.id),
  ]);
  return rowToRequest(row, mechanic, payment, rating);
}

/** Loads the discovery-mirror row for a mechanic id, if we have one. */
async function loadMechanic(id: number | null) {
  if (id == null) return null;
  return (await db.prepare('SELECT * FROM mechanics WHERE id=?').get(id)) ?? null;
}

/**
 * Reads a request and applies any time-based transition it has earned.
 * Centralising this is what stops the two apps disagreeing about status.
 */
async function loadRequest(id: number, userId?: number): Promise<any | null> {
  const row: any = userId
    ? await db.prepare('SELECT * FROM nearby_requests WHERE id=? AND user_id=?').get(id, userId)
    : await db.prepare('SELECT * FROM nearby_requests WHERE id=?').get(id);
  if (!row) return null;
  return advanceLifecycle(row);
}

async function advanceLifecycle(row: any): Promise<any> {
  // Nobody answered in time — do not leave the user watching a spinner.
  if (row.status === 'PENDING_MECHANIC_RESPONSE') {
    const ageSec = (Date.now() - new Date(row.created_at).getTime()) / 1000;
    if (ageSec > NEARBY_CONFIG.mechanicResponseTimeoutSeconds) {
      await db
        .prepare("UPDATE nearby_requests SET status='NO_MECHANIC_FOUND', updated_at=now() WHERE id=?")
        .run(row.id);
      await notify(
        'user',
        row.user_id,
        'No mechanic available',
        `No mechanic responded to ${row.reference}. Please try again.`,
      );
      return { ...row, status: 'NO_MECHANIC_FOUND' };
    }
  }

  // Work is done and an invoice exists: the customer's next action is to pay,
  // so settle on the status that says so. COMPLETED is only ever transient.
  if (row.status === 'COMPLETED') {
    let payment: any = await loadPayment(row.id);

    // Self-heal: a job marked complete without an invoice (an interrupted
    // completion, or a row from before this feature existed) would otherwise
    // sit here forever with no way for the customer to pay or rate.
    if (!payment) {
      const amount = resolveFinalAmount(row, row.final_amount);
      if (amount == null) return row;
      await db
        .prepare(
          `INSERT INTO nearby_payments (request_id,user_id,mechanic_id,amount,status)
           VALUES (?,?,?,?,'PENDING') ON CONFLICT (request_id) DO NOTHING`,
        )
        .run(row.id, row.user_id, row.mechanic_id, amount);
      await db
        .prepare('UPDATE nearby_requests SET final_amount=COALESCE(final_amount,?) WHERE id=?')
        .run(amount, row.id);
      payment = await loadPayment(row.id);
    }

    if (payment && payment.status === 'PENDING') {
      await db
        .prepare("UPDATE nearby_requests SET status='PAYMENT_PENDING', completed_at=COALESCE(completed_at,now()), updated_at=now() WHERE id=?")
        .run(row.id);
      return { ...row, status: 'PAYMENT_PENDING' };
    }
  }

  if (row.status === 'MECHANIC_ON_THE_WAY') {
    const { arrived } = liveEta(row);
    if (arrived) {
      await db
        .prepare("UPDATE nearby_requests SET status='ARRIVED', eta_minutes=0, updated_at=now() WHERE id=?")
        .run(row.id);
      await notify(
        'user',
        row.user_id,
        'Your mechanic has arrived',
        `The mechanic for ${row.reference} has reached your location.`,
      );
      return { ...row, status: 'ARRIVED', eta_minutes: 0 };
    }
  }

  return row;
}

/* ── Dispatch (the replaceable part) ─────────── */

/**
 * POC matching: always resolves to the configured mechanic, but only if that
 * mechanic exists, is approved and is marked available — so the "no mechanic
 * found" and "mechanic busy" paths are real rather than theoretical.
 */
async function assignMechanic(_userLocation: GeoLocation): Promise<any | null> {
  const mech: any = await db
    .prepare("SELECT * FROM mechanics WHERE id=? AND approval_status='approved' AND available=1")
    .get(NEARBY_CONFIG.pocMechanicId);
  return mech ?? null;
}

/** Server-to-server push of the request into the mechanic module. */
async function dispatchToMechanicModule(payload: Record<string, unknown>): Promise<boolean> {
  try {
    const res = await fetch(`${NEARBY_CONFIG.mechanicApiUrl}/internal/nearby/dispatch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-secret': NEARBY_CONFIG.dispatchSecret,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.error('[user-backend] dispatch rejected by mechanic module:', res.status);
      return false;
    }
    return true;
  } catch (err: any) {
    console.error('[user-backend] dispatch failed:', err.message);
    return false;
  }
}

/* ── Routes ──────────────────────────────────── */

// The catalogue is served from the API too, so a mobile client does not have
// to ship its own copy of the list.
nearbyRouter.get('/nearby/issues', (_req, res) => res.json(VEHICLE_ISSUES));

nearbyRouter.get('/nearby/config', requireAuth, (_req, res) =>
  res.json({
    etaSpeedup: NEARBY_CONFIG.etaSpeedup,
    responseTimeoutSeconds: NEARBY_CONFIG.mechanicResponseTimeoutSeconds,
    averageSpeedKmph: ETA_CONFIG.averageSpeedKmph,
    fallbackLocation: MOCK_LOCATION_CONFIG.fallbackUserLocation,
  }),
);

/** Price preview while the user is still filling in the dialog. */
nearbyRouter.post('/nearby/estimate', requireAuth, h(async (req: AuthedRequest, res) => {
  const { issueKey, vehicleId, distanceKm } = req.body ?? {};
  if (!issueKey) return res.status(400).json({ error: 'issueKey is required' });

  let vehicleYear: number | null = null;
  if (vehicleId) {
    const veh: any = await db
      .prepare('SELECT year FROM vehicles WHERE id=? AND user_id=?')
      .get(vehicleId, req.auth!.id);
    vehicleYear = veh ? Number(veh.year) : null;
  }
  res.json(getEstimatedPrice({ issueKey, vehicleYear, distanceKm: num(distanceKm) }));
}));

/** The user's current live request, if any. Polled by the user app. */
nearbyRouter.get('/nearby/requests/active', requireAuth, h(async (req: AuthedRequest, res) => {
  const row: any = await db
    .prepare(
      `SELECT * FROM nearby_requests
       WHERE user_id=? AND status IN (${ACTIVE_SQL})
       ORDER BY id DESC LIMIT 1`,
    )
    .get(req.auth!.id);
  if (!row) return res.json(null);
  const fresh = await advanceLifecycle(row);
  res.json(await hydrate(fresh));
}));

/** Most recent request whatever its state — used to show the outcome banner. */
nearbyRouter.get('/nearby/requests/latest', requireAuth, h(async (req: AuthedRequest, res) => {
  const row: any = await db
    .prepare('SELECT * FROM nearby_requests WHERE user_id=? ORDER BY id DESC LIMIT 1')
    .get(req.auth!.id);
  if (!row) return res.json(null);
  const fresh = await advanceLifecycle(row);
  res.json(await hydrate(fresh));
}));

nearbyRouter.get('/nearby/requests/:id', requireAuth, h(async (req: AuthedRequest, res) => {
  const row = await loadRequest(Number(req.params.id), req.auth!.id);
  if (!row) return res.status(404).json({ error: 'Request not found' });
  res.json(await hydrate(row));
}));

nearbyRouter.post('/nearby/requests', requireAuth, h(async (req: AuthedRequest, res) => {
  const { vehicleId, issueKey, description, userLocation, locationSource } = req.body ?? {};

  if (!issueKey || !getIssue(issueKey))
    return res.status(400).json({ error: 'A valid issueKey is required' });
  if (!vehicleId) return res.status(400).json({ error: 'Select a vehicle before requesting help' });
  if (!userLocation || userLocation.latitude == null || userLocation.longitude == null)
    return res.status(400).json({ error: 'Your location is required to find nearby mechanics' });

  const issue = getIssue(issueKey)!;
  // Description is optional only when the user cannot name the issue.
  if (!issue.requiresDiagnosis && issueKey === 'other' && !String(description ?? '').trim())
    return res.status(400).json({ error: 'Please describe the issue' });

  const vehicle: any = await db
    .prepare('SELECT * FROM vehicles WHERE id=? AND user_id=? AND is_active=1')
    .get(vehicleId, req.auth!.id);
  if (!vehicle) return res.status(400).json({ error: 'Vehicle does not belong to you' });

  const existing: any = await db
    .prepare(
      `SELECT id, reference FROM nearby_requests
       WHERE user_id=? AND status IN (${BLOCKING_SQL})
       ORDER BY id DESC LIMIT 1`,
    )
    .get(req.auth!.id);
  if (existing)
    return res.status(409).json({
      error: 'You already have a live request in progress.',
      requestId: existing.id,
      reference: existing.reference,
    });

  const location: GeoLocation = {
    latitude: Number(userLocation.latitude),
    longitude: Number(userLocation.longitude),
    label: userLocation.label ?? null,
  };

  const mech = await assignMechanic(location);
  if (!mech) {
    return res.status(503).json({
      error: 'No mechanic is available near you right now. Please try again shortly.',
    });
  }

  const mechanicLocation = mockMechanicLocationNear(location, mech.id, mech.location ?? null);
  const distanceKm = calculateDistance(mechanicLocation, location);
  const etaMinutes = calculateETA(distanceKm);
  const pricing = getEstimatedPrice({
    issueKey,
    vehicleYear: Number(vehicle.year),
    distanceKm,
  });

  const inserted = await db
    .prepare(
      `INSERT INTO nearby_requests
         (reference,user_id,vehicle_id,mechanic_id,vehicle_make,vehicle_model,vehicle_year,vehicle_reg_no,
          issue_key,issue_label,description,user_lat,user_lng,user_location_label,location_source,
          mechanic_lat,mechanic_lng,mechanic_location_label,distance_km,eta_minutes,initial_eta_minutes,
          price_min,price_max,price_currency,price_requires_diagnosis,status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'PENDING_MECHANIC_RESPONSE')`,
    )
    .run(
      `SOS-${Date.now().toString().slice(-8)}`,
      req.auth!.id, vehicle.id, mech.id,
      vehicle.make, vehicle.model, vehicle.year, vehicle.registration_no,
      issueKey, issueLabel(issueKey), String(description ?? '').trim() || null,
      location.latitude, location.longitude, location.label,
      locationSource ?? 'mock',
      mechanicLocation.latitude, mechanicLocation.longitude, mechanicLocation.label,
      distanceKm, etaMinutes, etaMinutes,
      pricing.min, pricing.max, pricing.currency, pricing.requiresDiagnosis ? 1 : 0,
    );

  const id = Number(inserted.lastInsertRowid);
  const row: any = await db.prepare('SELECT * FROM nearby_requests WHERE id=?').get(id);
  const me: any = await db.prepare('SELECT name, phone FROM users WHERE id=?').get(req.auth!.id);

  const dispatched = await dispatchToMechanicModule({
    originRequestId: id,
    reference: row.reference,
    mechanicId: mech.id,
    userId: req.auth!.id,
    userName: me?.name ?? null,
    userPhone: me?.phone ?? null,
    vehicle: {
      make: vehicle.make,
      model: vehicle.model,
      year: vehicle.year,
      registrationNo: vehicle.registration_no,
    },
    issueKey,
    issueLabel: issueLabel(issueKey),
    description: row.description,
    userLocation: location,
    mechanicLocation,
    distanceKm,
    etaMinutes,
    pricing,
  });

  if (!dispatched) {
    // The mechanic module is unreachable: fail loudly instead of leaving the
    // user watching a radar that will never resolve.
    await db
      .prepare("UPDATE nearby_requests SET status='NO_MECHANIC_FOUND', updated_at=now() WHERE id=?")
      .run(id);
    return res.status(502).json({
      error: 'We could not reach our mechanic network. Please try again in a moment.',
      requestId: id,
    });
  }

  await notify('user', req.auth!.id, 'Looking for a mechanic', `We are dispatching ${row.reference} to a nearby mechanic.`);
  logAction('nearby_request', `user=${req.auth!.id} issue=${issueKey} mechanic=${mech.id}`);

  res.status(201).json(rowToRequest(row, mech));
}));

nearbyRouter.post('/nearby/requests/:id/cancel', requireAuth, h(async (req: AuthedRequest, res) => {
  const row = await loadRequest(Number(req.params.id), req.auth!.id);
  if (!row) return res.status(404).json({ error: 'Request not found' });
  if (['COMPLETED', 'CANCELLED', 'REJECTED', 'NO_MECHANIC_FOUND'].includes(row.status))
    return res.status(400).json({ error: `This request is already ${row.status.toLowerCase()}` });

  await db
    .prepare("UPDATE nearby_requests SET status='CANCELLED', updated_at=now() WHERE id=?")
    .run(row.id);

  // Best-effort: pull the request off the mechanic's screen too.
  await fetch(`${NEARBY_CONFIG.mechanicApiUrl}/internal/nearby/${row.id}/cancel`, {
    method: 'POST',
    headers: { 'x-internal-secret': NEARBY_CONFIG.dispatchSecret },
    signal: AbortSignal.timeout(4000),
  }).catch(() => undefined);

  logAction('nearby_cancel', `user=${req.auth!.id} request=${row.id}`);
  const updated = await loadRequest(row.id, req.auth!.id);
  res.json(await hydrate(updated));
}));

/* ── Internal endpoint (mechanic module → here) ── */

function requireInternal(req: Request, res: Response, next: NextFunction) {
  if (req.headers['x-internal-secret'] !== NEARBY_CONFIG.dispatchSecret) {
    return res.status(401).json({ error: 'Invalid internal secret' });
  }
  next();
}

/** The mechanic module reports its accept/reject decision here. */
nearbyRouter.post(
  '/internal/nearby/:id/status',
  requireInternal,
  h(async (req, res) => {
    const { status, reason, finalAmount } = req.body ?? {};
    const allowed: NearbyRequestStatus[] = [
      'ACCEPTED', 'REJECTED', 'MECHANIC_ON_THE_WAY', 'ARRIVED', 'IN_SERVICE', 'COMPLETED',
    ];
    if (!allowed.includes(status)) return res.status(400).json({ error: 'Unsupported status' });

    const row: any = await db.prepare('SELECT * FROM nearby_requests WHERE id=?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Request not found' });
    if (['CANCELLED', 'COMPLETED'].includes(row.status))
      return res.status(409).json({ error: `Request is already ${row.status}` });

    if (status === 'ACCEPTED') {
      // Accepting starts the journey immediately; the countdown is measured
      // from accepted_at, so this is also the ETA clock's zero point.
      await db
        .prepare(
          `UPDATE nearby_requests
             SET status='MECHANIC_ON_THE_WAY', accepted_at=now(), responded_at=now(), updated_at=now()
           WHERE id=?`,
        )
        .run(row.id);
      await notify('user', row.user_id, 'Mechanic found', `Your mechanic is on the way for ${row.reference}.`);
    } else if (status === 'REJECTED') {
      await db
        .prepare(
          "UPDATE nearby_requests SET status='REJECTED', rejection_reason=?, responded_at=now(), updated_at=now() WHERE id=?",
        )
        .run(reason ?? null, row.id);
      await notify(
        'user',
        row.user_id,
        'Mechanic declined',
        `The mechanic could not take ${row.reference}. Please raise a new request.`,
      );
    } else if (status === 'COMPLETED') {
      // Completion is the moment the invoice comes into existence. Raising the
      // payment row here (rather than lazily when the user opens the payment
      // step) is what guarantees exactly one payment per job.
      const amount = resolveFinalAmount(row, finalAmount);
      if (amount == null)
        return res.status(400).json({ error: 'A final amount is required to complete this job' });

      await db
        .prepare(
          `UPDATE nearby_requests
             SET status='PAYMENT_PENDING', final_amount=?, completed_at=now(), updated_at=now()
           WHERE id=?`,
        )
        .run(amount, row.id);

      await db
        .prepare(
          `INSERT INTO nearby_payments (request_id,user_id,mechanic_id,amount,status)
           VALUES (?,?,?,?,'PENDING')
           ON CONFLICT (request_id) DO UPDATE SET amount=EXCLUDED.amount, updated_at=now()`,
        )
        .run(row.id, row.user_id, row.mechanic_id, amount);

      const mech: any = await loadMechanic(num(row.mechanic_id));
      await notify(
        'user',
        row.user_id,
        'Job completed',
        `${mech?.name ?? 'Your mechanic'} has completed your service. Please complete the payment.`,
      );
      logAction('nearby_complete', `request=${row.id} amount=${amount}`);
    } else {
      await db
        .prepare('UPDATE nearby_requests SET status=?, updated_at=now() WHERE id=?')
        .run(status, row.id);
    }

    const updated = await db.prepare('SELECT * FROM nearby_requests WHERE id=?').get(row.id);
    res.json(await hydrate(updated));
  }),
);

/* ── Final amount ────────────────────────────── */

/**
 * The mechanic may enter a final amount; if they do not, fall back to the
 * midpoint of the estimate they quoted. Never invents a number out of thin
 * air, and never lets a job complete with no amount at all.
 */
function resolveFinalAmount(row: any, provided: unknown): number | null {
  const given = Number(provided);
  if (Number.isFinite(given) && given > 0) return Math.round(given * 100) / 100;

  const min = num(row.price_min);
  const max = num(row.price_max);
  if (min != null && max != null && max > 0) return Math.round(((min + max) / 2) * 100) / 100;
  return null;
}

/* ── Payment ─────────────────────────────────── */

/** Keeps the mechanic module's mirror in step with payment/rating outcomes. */
async function reportToMechanicModule(path: string, body: Record<string, unknown>): Promise<boolean> {
  try {
    const res = await fetch(`${NEARBY_CONFIG.mechanicApiUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-secret': NEARBY_CONFIG.dispatchSecret,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch (err: any) {
    console.error('[user-backend] mechanic sync failed:', err.message);
    return false;
  }
}

/** Loads a request the caller owns, or sends the right error. */
async function requireOwnedRequest(req: AuthedRequest, res: Response): Promise<any | null> {
  const row = await loadRequest(Number(req.params.id), req.auth!.id);
  if (!row) {
    res.status(404).json({ error: 'Request not found' });
    return null;
  }
  return row;
}

nearbyRouter.get('/nearby/requests/:id/payment', requireAuth, h(async (req: AuthedRequest, res) => {
  const row = await requireOwnedRequest(req, res);
  if (!row) return;
  const payment = await loadPayment(row.id);
  res.json(payment ? paymentToDto(payment) : null);
}));

nearbyRouter.post('/nearby/requests/:id/payment/online', requireAuth, h(async (req: AuthedRequest, res) => {
  const row = await requireOwnedRequest(req, res);
  if (!row) return;

  const payment: any = await loadPayment(row.id);
  if (!payment) return res.status(400).json({ error: 'This job has not been completed yet' });
  if (payment.status === 'PAID')
    return res.status(409).json({ error: 'This job has already been paid', payment: paymentToDto(payment) });
  if (payment.status === 'CASH_SELECTED')
    return res.status(409).json({ error: 'Cash was already selected for this job' });

  const amount = Number(payment.amount);
  const intent = await paymentGateway.initiateOnlinePayment({
    requestId: row.id,
    amount,
    currency: PAYMENT_CONFIG.currency,
  });

  await db
    .prepare("UPDATE nearby_payments SET method='ONLINE', attempts=attempts+1, updated_at=now() WHERE id=?")
    .run(payment.id);

  const outcome = await paymentGateway.processOnlinePayment(intent);

  if (!outcome.success) {
    // A failed attempt is recorded, not swallowed — the customer can retry.
    await db
      .prepare("UPDATE nearby_payments SET status='FAILED', failure_reason=?, updated_at=now() WHERE id=?")
      .run(outcome.failureReason ?? 'Payment failed', payment.id);
    const failed = await loadPayment(row.id);
    return res.status(402).json({
      error: outcome.failureReason ?? 'Payment failed. Please try again.',
      payment: paymentToDto(failed),
    });
  }

  await db
    .prepare(
      "UPDATE nearby_payments SET status='PAID', transaction_id=?, failure_reason=NULL, updated_at=now() WHERE id=?",
    )
    .run(outcome.transactionId, payment.id);
  await db
    .prepare("UPDATE nearby_requests SET status='PAYMENT_COMPLETED', updated_at=now() WHERE id=?")
    .run(row.id);

  await reportToMechanicModule(`/internal/nearby/${row.id}/payment`, {
    method: 'ONLINE',
    status: 'PAID',
    amount,
    transactionId: outcome.transactionId,
  });
  await notify('user', req.auth!.id, 'Payment successful', `Paid for ${row.reference}.`);
  logAction('nearby_payment_online', `request=${row.id} txn=${outcome.transactionId}`);

  const updated = await db.prepare('SELECT * FROM nearby_requests WHERE id=?').get(row.id);
  res.json(await hydrate(updated));
}));

nearbyRouter.post('/nearby/requests/:id/payment/cash', requireAuth, h(async (req: AuthedRequest, res) => {
  const row = await requireOwnedRequest(req, res);
  if (!row) return;

  const payment: any = await loadPayment(row.id);
  if (!payment) return res.status(400).json({ error: 'This job has not been completed yet' });
  if (payment.status === 'PAID')
    return res.status(409).json({ error: 'This job has already been paid online' });

  const amount = Number(payment.amount);
  // No gateway call and no capture: cash only records the customer's choice.
  const intent = await paymentGateway.selectCashPayment({ requestId: row.id, amount });

  await db
    .prepare(
      `UPDATE nearby_payments
         SET method='CASH', status='CASH_SELECTED', transaction_id=?, failure_reason=NULL, updated_at=now()
       WHERE id=?`,
    )
    .run(intent.reference, payment.id);
  await db
    .prepare("UPDATE nearby_requests SET status='CASH_SELECTED', updated_at=now() WHERE id=?")
    .run(row.id);

  await reportToMechanicModule(`/internal/nearby/${row.id}/payment`, {
    method: 'CASH',
    status: 'CASH_SELECTED',
    amount,
    transactionId: intent.reference,
  });
  logAction('nearby_payment_cash', `request=${row.id}`);

  const updated = await db.prepare('SELECT * FROM nearby_requests WHERE id=?').get(row.id);
  res.json(await hydrate(updated));
}));

/* ── Rating ──────────────────────────────────── */

nearbyRouter.post('/nearby/requests/:id/rating', requireAuth, h(async (req: AuthedRequest, res) => {
  const { rating, review } = req.body ?? {};
  const stars = Number(rating);
  if (!Number.isInteger(stars) || stars < 1 || stars > 5)
    return res.status(400).json({ error: 'Select a rating between 1 and 5 stars' });

  const row = await requireOwnedRequest(req, res);
  if (!row) return;

  // Ownership and completeness are checked server-side; the UI guard is a
  // convenience, not the rule.
  // Checked first so a second submission gets the accurate reason rather than
  // the generic "not rateable" that the RATED status would otherwise produce.
  const existing = await loadRating(row.id);
  if (existing)
    return res.status(409).json({ error: 'You have already rated this job', rating: ratingToDto(existing) });

  // Rating comes AFTER payment is settled one way or the other. Allowing it
  // while payment is still pending would also let a later payment transition
  // overwrite RATED.
  const rateable = ['PAYMENT_COMPLETED', 'CASH_SELECTED'];
  if (!rateable.includes(row.status))
    return res.status(400).json({
      error:
        row.status === 'PAYMENT_PENDING'
          ? 'Please complete the payment before rating this job'
          : 'You can only rate a completed job',
    });

  const me: any = await db.prepare('SELECT name FROM users WHERE id=?').get(req.auth!.id);
  const comment = String(review ?? '').trim() || null;

  await db
    .prepare(
      `INSERT INTO nearby_ratings (request_id,user_id,user_name,mechanic_id,rating,review)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT (request_id) DO NOTHING`,
    )
    .run(row.id, req.auth!.id, me?.name ?? null, row.mechanic_id, stars, comment);

  await db.prepare("UPDATE nearby_requests SET status='RATED', updated_at=now() WHERE id=?").run(row.id);

  // Push into the mechanic module so it lands in the existing reviews table
  // and the mechanic profile summary picks it up without extra wiring.
  await reportToMechanicModule(`/internal/nearby/${row.id}/rating`, {
    rating: stars,
    review: comment,
    userId: req.auth!.id,
    userName: me?.name ?? null,
    mechanicId: row.mechanic_id,
  });

  // Keep the local discovery mirror's headline rating in step, exactly as the
  // existing service-request review flow does.
  if (row.mechanic_id != null) {
    const agg: any = await db
      .prepare('SELECT AVG(rating) AS avg, COUNT(*) AS cnt FROM nearby_ratings WHERE mechanic_id=?')
      .get(row.mechanic_id);
    if (agg?.cnt) {
      await db
        .prepare('UPDATE mechanics SET rating=?, reviews_count=COALESCE(reviews_count,0)+1 WHERE id=?')
        .run(Math.round(Number(agg.avg) * 10) / 10, row.mechanic_id);
    }
  }

  logAction('nearby_rating', `request=${row.id} stars=${stars}`);
  const updated = await db.prepare('SELECT * FROM nearby_requests WHERE id=?').get(row.id);
  res.json(await hydrate(updated));
}));
