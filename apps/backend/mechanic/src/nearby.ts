// ──────────────────────────────────────────────
// "Find Mechanics Nearby" — mechanic side.
//
// This module holds the dispatch mirror of am_user.nearby_requests. The user
// module pushes a request in over /internal/nearby/dispatch; every accept or
// reject here is reported straight back so the two apps never disagree about
// the status.
// ──────────────────────────────────────────────
import { Router, type Request, type Response, type NextFunction } from 'express';
import {
  calculateDistance,
  calculateETA,
  getEstimatedPrice,
  getMechanicPayout,
  mockMechanicLocationNear,
  summariseRatings,
} from '@automate/shared-utils';
import type { GeoLocation, NearbyRequest, PricingEstimate } from '@automate/shared-types';
import { db } from './db.js';
import { requireAuth, type AuthedRequest } from './auth.js';
import { logAction, notify } from './middleware.js';

const h =
  (fn: (req: any, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

export const nearbyRouter = Router();

export const NEARBY_CONFIG = {
  userApiUrl: process.env.USER_INTERNAL_API || 'http://localhost:4001/api',
  dispatchSecret: process.env.INTERNAL_DISPATCH_SECRET || 'automate_internal_dispatch',
} as const;

const num = (v: any): number | null => (v == null ? null : Number(v));

function requireInternal(req: Request, res: Response, next: NextFunction) {
  if (req.headers['x-internal-secret'] !== NEARBY_CONFIG.dispatchSecret) {
    return res.status(401).json({ error: 'Invalid internal secret' });
  }
  next();
}

function pricingFromRow(row: any): PricingEstimate {
  const derived = getEstimatedPrice({
    issueKey: row.issue_key,
    vehicleYear: num(row.vehicle_year),
    distanceKm: num(row.distance_km),
  });
  if (row.price_requires_diagnosis) return derived;
  return { ...derived, min: num(row.price_min), max: num(row.price_max) };
}

function rowToRequest(row: any): NearbyRequest & { mechanicPayout: ReturnType<typeof getMechanicPayout> } {
  const pricing = pricingFromRow(row);
  const userLocation: GeoLocation = {
    latitude: Number(row.user_lat),
    longitude: Number(row.user_lng),
    label: row.user_location_label ?? null,
  };
  const mechanicLocation: GeoLocation | null =
    row.mechanic_lat == null
      ? null
      : {
          latitude: Number(row.mechanic_lat),
          longitude: Number(row.mechanic_lng),
          label: row.mechanic_location_label ?? null,
        };

  return {
    // The mechanic app addresses requests by the ORIGIN id, so both modules
    // and both UIs can talk about "request 12" and mean the same thing.
    id: row.origin_request_id,
    reference: row.reference,
    userId: row.user_id,
    userName: row.user_name ?? null,
    userPhone: row.user_phone ?? null,
    mechanicId: row.mechanic_id,
    vehicleId: null,
    vehicle: {
      id: null,
      make: row.vehicle_make ?? '',
      model: row.vehicle_model ?? '',
      year: num(row.vehicle_year),
      registrationNo: row.vehicle_reg_no ?? null,
    },
    issueKey: row.issue_key,
    issueLabel: row.issue_label,
    description: row.description ?? null,
    userLocation,
    mechanicLocation,
    locationSource: 'mock',
    distanceKm: num(row.distance_km),
    etaMinutes: num(row.eta_minutes),
    pricing,
    finalAmount: num(row.final_amount),
    status: row.status,
    rejectionReason: row.rejection_reason ?? null,
    paymentMethod: row.payment_method ?? null,
    paymentStatus: row.payment_status ?? null,
    customerRating: num(row.customer_rating),
    completedAt: row.completed_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    respondedAt: row.responded_at ?? null,
    mechanicPayout: getMechanicPayout(pricing),
  } as any;
}

/** Reports a status transition back to the owning module. */
async function reportToUserModule(
  originId: number,
  status: string,
  reason?: string | null,
  finalAmount?: number | null,
) {
  try {
    const res = await fetch(`${NEARBY_CONFIG.userApiUrl}/internal/nearby/${originId}/status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-secret': NEARBY_CONFIG.dispatchSecret,
      },
      body: JSON.stringify({ status, reason, finalAmount }),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch (err: any) {
    console.error('[mechanic-backend] status report failed:', err.message);
    return false;
  }
}

/* ── Internal: receive a dispatched request ──── */

nearbyRouter.post('/internal/nearby/dispatch', requireInternal, h(async (req, res) => {
  const p = req.body ?? {};
  if (!p.originRequestId || !p.mechanicId)
    return res.status(400).json({ error: 'originRequestId and mechanicId are required' });

  const mech: any = await db.prepare('SELECT * FROM mechanics WHERE id=?').get(p.mechanicId);
  if (!mech) return res.status(404).json({ error: 'Mechanic not found in this module' });
  if (!mech.available) return res.status(409).json({ error: 'Mechanic is not available' });

  const mechanicLocation: GeoLocation =
    p.mechanicLocation ?? mockMechanicLocationNear(p.userLocation, mech.id, mech.location);

  // ON CONFLICT keeps a retried dispatch idempotent instead of duplicating
  // the request on the mechanic's screen.
  await db
    .prepare(
      `INSERT INTO nearby_requests
         (origin_request_id,reference,mechanic_id,user_id,user_name,user_phone,
          vehicle_make,vehicle_model,vehicle_year,vehicle_reg_no,
          issue_key,issue_label,description,
          user_lat,user_lng,user_location_label,mechanic_lat,mechanic_lng,mechanic_location_label,
          distance_km,eta_minutes,price_min,price_max,price_currency,price_requires_diagnosis,status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'PENDING_MECHANIC_RESPONSE')
       ON CONFLICT (origin_request_id) DO UPDATE SET
         status='PENDING_MECHANIC_RESPONSE', updated_at=now()`,
    )
    .run(
      p.originRequestId, p.reference, mech.id, p.userId, p.userName ?? null, p.userPhone ?? null,
      p.vehicle?.make ?? null, p.vehicle?.model ?? null, p.vehicle?.year ?? null, p.vehicle?.registrationNo ?? null,
      p.issueKey, p.issueLabel, p.description ?? null,
      p.userLocation?.latitude, p.userLocation?.longitude, p.userLocation?.label ?? null,
      mechanicLocation.latitude, mechanicLocation.longitude, mechanicLocation.label ?? null,
      p.distanceKm ?? calculateDistance(mechanicLocation, p.userLocation),
      p.etaMinutes ?? calculateETA(calculateDistance(mechanicLocation, p.userLocation)),
      p.pricing?.min ?? null, p.pricing?.max ?? null, p.pricing?.currency ?? 'INR',
      p.pricing?.requiresDiagnosis ? 1 : 0,
    );

  await notify(
    'mechanic',
    mech.id,
    'New roadside request',
    `${p.issueLabel} · ${p.vehicle?.make ?? ''} ${p.vehicle?.model ?? ''} · ${p.reference}`,
  );
  logAction('nearby_dispatch', `mechanic=${mech.id} request=${p.originRequestId}`);
  res.status(201).json({ ok: true });
}));

/** The user cancelled — take it off the mechanic's screen. */
nearbyRouter.post('/internal/nearby/:id/cancel', requireInternal, h(async (req, res) => {
  await db
    .prepare(
      `UPDATE nearby_requests SET status='CANCELLED', updated_at=now()
       WHERE origin_request_id=? AND status NOT IN ('COMPLETED','REJECTED')`,
    )
    .run(req.params.id);
  res.json({ ok: true });
}));

/* ── Mechanic-facing routes ──────────────────── */

/** Everything live for the signed-in mechanic. Polled by the mechanic app. */
nearbyRouter.get('/nearby/requests', requireAuth, h(async (req: AuthedRequest, res) => {
  const rows = await db
    .prepare(
      `SELECT * FROM nearby_requests
       WHERE mechanic_id=? AND status IN ('PENDING_MECHANIC_RESPONSE','ACCEPTED','MECHANIC_ON_THE_WAY',
                                          'ARRIVED','IN_SERVICE','PAYMENT_PENDING','PAYMENT_COMPLETED',
                                          'CASH_SELECTED')
       ORDER BY created_at DESC`,
    )
    .all(req.auth!.id);
  res.json(rows.map(rowToRequest));
}));

nearbyRouter.get('/nearby/requests/history', requireAuth, h(async (req: AuthedRequest, res) => {
  const rows = await db
    .prepare('SELECT * FROM nearby_requests WHERE mechanic_id=? ORDER BY created_at DESC LIMIT 30')
    .all(req.auth!.id);
  res.json(rows.map(rowToRequest));
}));

nearbyRouter.get('/nearby/requests/:id', requireAuth, h(async (req: AuthedRequest, res) => {
  const row: any = await db
    .prepare('SELECT * FROM nearby_requests WHERE origin_request_id=? AND mechanic_id=?')
    .get(req.params.id, req.auth!.id);
  if (!row) return res.status(404).json({ error: 'Request not found' });
  res.json(rowToRequest(row));
}));

/**
 * Marks the alert as played. Guarded by the `alerted` column rather than
 * component state so a re-render, a refresh or a second tab cannot replay
 * the sound for the same request.
 */
nearbyRouter.post('/nearby/requests/:id/alerted', requireAuth, h(async (req: AuthedRequest, res) => {
  const result = await db
    .prepare('UPDATE nearby_requests SET alerted=1 WHERE origin_request_id=? AND mechanic_id=? AND alerted=0')
    .run(req.params.id, req.auth!.id);
  res.json({ ok: true, firstAlert: result.changes > 0 });
}));

nearbyRouter.post('/nearby/requests/:id/accept', requireAuth, h(async (req: AuthedRequest, res) => {
  const row: any = await db
    .prepare('SELECT * FROM nearby_requests WHERE origin_request_id=? AND mechanic_id=?')
    .get(req.params.id, req.auth!.id);
  if (!row) return res.status(404).json({ error: 'Request not found' });
  if (row.status === 'CANCELLED')
    return res.status(409).json({ error: 'The customer cancelled this request' });
  if (row.status !== 'PENDING_MECHANIC_RESPONSE')
    return res.status(400).json({ error: `Cannot accept a request that is ${row.status}` });

  // The user module owns the status: only persist locally once it agrees,
  // otherwise the two databases drift apart.
  const reported = await reportToUserModule(row.origin_request_id, 'ACCEPTED');
  if (!reported)
    return res.status(502).json({ error: 'Could not confirm with dispatch. Please try again.' });

  await db
    .prepare(
      "UPDATE nearby_requests SET status='MECHANIC_ON_THE_WAY', responded_at=now(), updated_at=now() WHERE id=?",
    )
    .run(row.id);
  await notify('mechanic', req.auth!.id, 'Job accepted', `You accepted ${row.reference}. Navigate to the customer.`);
  logAction('nearby_accept', `mechanic=${req.auth!.id} request=${row.origin_request_id}`);

  const updated: any = await db.prepare('SELECT * FROM nearby_requests WHERE id=?').get(row.id);
  res.json(rowToRequest(updated));
}));

nearbyRouter.post('/nearby/requests/:id/reject', requireAuth, h(async (req: AuthedRequest, res) => {
  const { reason } = req.body ?? {};
  const row: any = await db
    .prepare('SELECT * FROM nearby_requests WHERE origin_request_id=? AND mechanic_id=?')
    .get(req.params.id, req.auth!.id);
  if (!row) return res.status(404).json({ error: 'Request not found' });
  if (row.status !== 'PENDING_MECHANIC_RESPONSE')
    return res.status(400).json({ error: `Cannot decline a request that is ${row.status}` });

  const reported = await reportToUserModule(row.origin_request_id, 'REJECTED', reason ?? null);
  if (!reported)
    return res.status(502).json({ error: 'Could not confirm with dispatch. Please try again.' });

  await db
    .prepare(
      "UPDATE nearby_requests SET status='REJECTED', rejection_reason=?, responded_at=now(), updated_at=now() WHERE id=?",
    )
    .run(reason ?? null, row.id);
  logAction('nearby_reject', `mechanic=${req.auth!.id} request=${row.origin_request_id}`);

  const updated: any = await db.prepare('SELECT * FROM nearby_requests WHERE id=?').get(row.id);
  res.json(rowToRequest(updated));
}));

/** Progress an accepted job: on the way -> arrived -> in service -> completed. */
nearbyRouter.post('/nearby/requests/:id/status', requireAuth, h(async (req: AuthedRequest, res) => {
  const { status } = req.body ?? {};
  // COMPLETED is deliberately absent: completing a job needs a final amount,
  // so it goes through POST /nearby/requests/:id/complete instead.
  const allowed = ['MECHANIC_ON_THE_WAY', 'ARRIVED', 'IN_SERVICE'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Unsupported status' });

  const row: any = await db
    .prepare('SELECT * FROM nearby_requests WHERE origin_request_id=? AND mechanic_id=?')
    .get(req.params.id, req.auth!.id);
  if (!row) return res.status(404).json({ error: 'Request not found' });

  const reported = await reportToUserModule(row.origin_request_id, status);
  if (!reported) return res.status(502).json({ error: 'Could not sync with dispatch. Please try again.' });

  await db.prepare('UPDATE nearby_requests SET status=?, updated_at=now() WHERE id=?').run(status, row.id);
  const updated: any = await db.prepare('SELECT * FROM nearby_requests WHERE id=?').get(row.id);
  res.json(rowToRequest(updated));
}));

/* ── Job completion ──────────────────────────── */

/**
 * Completing a job is the only place a final amount is set. The user module
 * owns the transition, so it is told first: if it refuses, nothing changes
 * here and the mechanic can retry rather than the two sides drifting apart.
 */
nearbyRouter.post('/nearby/requests/:id/complete', requireAuth, h(async (req: AuthedRequest, res) => {
  const { finalAmount } = req.body ?? {};
  const row: any = await db
    .prepare('SELECT * FROM nearby_requests WHERE origin_request_id=? AND mechanic_id=?')
    .get(req.params.id, req.auth!.id);
  if (!row) return res.status(404).json({ error: 'Request not found' });

  const completable = ['MECHANIC_ON_THE_WAY', 'ARRIVED', 'IN_SERVICE'];
  if (!completable.includes(row.status))
    return res.status(400).json({ error: `Cannot complete a job that is ${row.status}` });

  const amount = Number(finalAmount);
  if (!Number.isFinite(amount) || amount <= 0)
    return res.status(400).json({ error: 'Enter the final service amount before completing the job' });

  const reported = await reportToUserModule(row.origin_request_id, 'COMPLETED', null, amount);
  if (!reported)
    return res.status(502).json({ error: 'Could not confirm completion with dispatch. Please try again.' });

  await db
    .prepare(
      `UPDATE nearby_requests
         SET status='PAYMENT_PENDING', final_amount=?, payment_status='PENDING',
             completed_at=now(), updated_at=now()
       WHERE id=?`,
    )
    .run(amount, row.id);

  await notify(
    'mechanic',
    req.auth!.id,
    'Job completed',
    `${row.reference} is complete. Awaiting the customer's payment.`,
  );
  logAction('nearby_complete', `mechanic=${req.auth!.id} request=${row.origin_request_id} amount=${amount}`);

  const updated: any = await db.prepare('SELECT * FROM nearby_requests WHERE id=?').get(row.id);
  res.json(rowToRequest(updated));
}));

/* ── Internal: payment & rating pushed from the user module ── */

nearbyRouter.post('/internal/nearby/:id/payment', requireInternal, h(async (req, res) => {
  const { method, status, transactionId } = req.body ?? {};
  const requestStatus = status === 'PAID' ? 'PAYMENT_COMPLETED' : 'CASH_SELECTED';

  await db
    .prepare(
      `UPDATE nearby_requests
         SET payment_method=?, payment_status=?, status=?, updated_at=now()
       WHERE origin_request_id=?`,
    )
    .run(method ?? null, status ?? null, requestStatus, req.params.id);

  const row: any = await db
    .prepare('SELECT * FROM nearby_requests WHERE origin_request_id=?')
    .get(req.params.id);
  if (row) {
    await notify(
      'mechanic',
      row.mechanic_id,
      status === 'PAID' ? 'Payment received' : 'Cash payment selected',
      status === 'PAID'
        ? `${row.reference} was paid online (${transactionId ?? 'no reference'}).`
        : `The customer will pay you in cash for ${row.reference}.`,
    );
  }
  res.json({ ok: true });
}));

nearbyRouter.post('/internal/nearby/:id/rating', requireInternal, h(async (req, res) => {
  const { rating, review, userId, userName, mechanicId } = req.body ?? {};
  const stars = Number(rating);
  if (!Number.isInteger(stars) || stars < 1 || stars > 5)
    return res.status(400).json({ error: 'rating must be an integer between 1 and 5' });

  const row: any = await db
    .prepare('SELECT * FROM nearby_requests WHERE origin_request_id=?')
    .get(req.params.id);
  const mechId = row?.mechanic_id ?? mechanicId;
  if (!mechId) return res.status(404).json({ error: 'Request not found' });

  // Lands in the EXISTING reviews table, so the Reviews screen, the /feedback
  // summary and the profile all pick it up with no extra wiring. The partial
  // unique index on nearby_request_id makes a replayed push a no-op.
  await db
    .prepare(
      `INSERT INTO reviews (nearby_request_id,mechanic_id,user_id,user_name,rating,comment)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT (nearby_request_id) WHERE nearby_request_id IS NOT NULL DO NOTHING`,
    )
    .run(req.params.id, mechId, userId ?? null, userName ?? null, stars, review ?? null);

  if (row) {
    await db
      .prepare("UPDATE nearby_requests SET status='RATED', customer_rating=?, updated_at=now() WHERE id=?")
      .run(stars, row.id);
  }

  // Headline rating recomputed from the review rows, never stored blindly.
  const agg: any = await db
    .prepare('SELECT AVG(rating) AS avg, COUNT(*) AS cnt FROM reviews WHERE mechanic_id=?')
    .get(mechId);
  if (agg?.cnt) {
    await db
      .prepare('UPDATE mechanics SET rating=? WHERE id=?')
      .run(Math.round(Number(agg.avg) * 10) / 10, mechId);
  }

  await notify(
    'mechanic',
    mechId,
    'New customer rating',
    `You received a ${stars}-star rating from a recent customer.`,
  );
  logAction('nearby_rating_received', `mechanic=${mechId} stars=${stars}`);
  res.json({ ok: true });
}));

/* ── Ratings summary for the mechanic profile ── */

/**
 * Average, total and distribution derived from the review rows on every call.
 * Nothing is denormalised, so the profile cannot drift from reality.
 */
nearbyRouter.get('/nearby/ratings', requireAuth, h(async (req: AuthedRequest, res) => {
  const rows: any[] = await db
    .prepare(
      `SELECT id, nearby_request_id, service_request_id, user_id, user_name, rating, comment, created_at
       FROM reviews WHERE mechanic_id=? ORDER BY created_at DESC, id DESC`,
    )
    .all(req.auth!.id);

  const summary = summariseRatings(rows.map((r) => ({ rating: Number(r.rating) })));
  res.json({
    ...summary,
    reviews: rows.map((r) => ({
      id: r.id,
      requestId: r.nearby_request_id ?? r.service_request_id ?? 0,
      userId: r.user_id,
      // Display name only — no email, phone or address is exposed here.
      userName: r.user_name ?? 'Customer',
      mechanicId: req.auth!.id,
      rating: Number(r.rating),
      review: r.comment ?? null,
      createdAt: r.created_at,
    })),
  });
}));
