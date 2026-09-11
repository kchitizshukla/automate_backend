import { Router, type Request, type Response, type NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';
import { signToken, requireAuth, type AuthedRequest } from './auth.js';
import { logAction, notify } from './middleware.js';
import { nearbyRouter } from './nearby.js';
import { vehiclesRouter } from './vehicles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadDir = path.resolve(__dirname, '../uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (_req, file, cb) =>
      cb(null, `${Date.now()}-${file.originalname.replace(/\s+/g, '_')}`),
  }),
  limits: { fileSize: (Number(process.env.MAX_UPLOAD_MB) || 5) * 1024 * 1024 },
});

// Express 4 does not catch rejected promises, so every async handler is wrapped:
// a rejection becomes next(err) and lands in the shared error handler.
const h =
  (fn: (req: any, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

export const router = Router();

// Roadside assistance ("Find Mechanics Nearby") lives in its own module.
router.use(nearbyRouter);

// Vehicle master data + the user's garage. Mounted before the routes below so
// /vehicles/types and friends are matched ahead of any /vehicles/:id pattern.
router.use(vehiclesRouter);

// ── Auth ───────────────────────────────────────
router.post('/auth/signup', h(async (req, res) => {
  const { name, email, password, phone, address } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ error: 'name, email and password are required' });
  const exists = await db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (exists) return res.status(409).json({ error: 'Email already registered' });

  const hash = bcrypt.hashSync(password, 10);
  const info = await db
    .prepare('INSERT INTO users (name,email,password_hash,phone,address) VALUES (?,?,?,?,?)')
    .run(name, email, hash, phone ?? null, address ?? null);
  const user = { id: Number(info.lastInsertRowid), name, email, role: 'user' as const };
  logAction('signup', email);
  res.status(201).json({ token: signToken(user), user });
}));

router.post('/auth/login', h(async (req, res) => {
  const { email, password } = req.body;
  const row = (await db.prepare('SELECT * FROM users WHERE email = ?').get(email)) as any;
  if (!row || !bcrypt.compareSync(password || '', row.password_hash))
    return res.status(401).json({ error: 'Invalid credentials' });
  const user = { id: row.id, name: row.name, email: row.email, role: 'user' as const };
  logAction('login', email);
  res.json({ token: signToken(user), user });
}));

router.get('/auth/me', requireAuth, (req: AuthedRequest, res) => res.json(req.auth));

// ── Profile ────────────────────────────────────
router.get('/profile', requireAuth, h(async (req: AuthedRequest, res) => {
  const row = await db
    .prepare('SELECT id,name,email,phone,address,created_at FROM users WHERE id = ?')
    .get(req.auth!.id);
  res.json(row);
}));

router.put('/profile', requireAuth, h(async (req: AuthedRequest, res) => {
  const { name, phone, address } = req.body;
  await db
    .prepare('UPDATE users SET name=COALESCE(?,name), phone=COALESCE(?,phone), address=COALESCE(?,address) WHERE id=?')
    .run(name ?? null, phone ?? null, address ?? null, req.auth!.id);
  res.json(await db.prepare('SELECT id,name,email,phone,address FROM users WHERE id=?').get(req.auth!.id));
}));

// Vehicles (list/add/edit/delete + master data) live in ./vehicles.ts.

// ── Service requests ───────────────────────────
router.get('/services', requireAuth, h(async (req: AuthedRequest, res) => {
  res.json(
    await db.prepare(
      `SELECT s.*, v.make, v.model, v.registration_no,
              c.name AS vehicle_category_name, c.icon AS vehicle_category_icon
       FROM service_requests s
       JOIN vehicles v ON v.id = s.vehicle_id
       LEFT JOIN vehicle_categories c ON c.id = v.vehicle_category_id
       WHERE s.user_id=? ORDER BY s.created_at DESC`,
    ).all(req.auth!.id),
  );
}));

router.get('/services/:id', requireAuth, h(async (req: AuthedRequest, res) => {
  const row = await db
    .prepare('SELECT * FROM service_requests WHERE id=? AND user_id=?')
    .get(req.params.id, req.auth!.id);
  if (!row) return res.status(404).json({ error: 'Service request not found' });
  res.json(row);
}));

// Map common service categories -> estimated durations.
const DURATION_BY_CATEGORY: Record<string, string> = {
  'general service': '2 hrs',
  'brake repair': '3 hrs',
  'ac repair': '1.5 hrs',
  'tyre replacement': '4 hrs',
  'engine diagnostics': '1 hr',
  'car wash': '30 min',
};

router.post('/services', requireAuth, h(async (req: AuthedRequest, res) => {
  const { vehicleId, category, description, scheduledAt, mechanicId } = req.body;
  if (!vehicleId || !category || !description)
    return res.status(400).json({ error: 'vehicleId, category, description required' });
  const veh = await db
    .prepare('SELECT id FROM vehicles WHERE id=? AND user_id=? AND is_active=1')
    .get(vehicleId, req.auth!.id);
  if (!veh) return res.status(400).json({ error: 'Vehicle does not belong to user' });

  // Resolve optional chosen mechanic (must exist & be approved).
  let chosenMechanicId: number | null = null;
  if (mechanicId != null) {
    const mech = (await db
      .prepare("SELECT id FROM mechanics WHERE id=? AND approval_status='approved'")
      .get(mechanicId)) as any;
    if (mech) chosenMechanicId = mech.id;
  }
  const status = chosenMechanicId ? 'assigned' : 'pending';
  const estimatedDuration = DURATION_BY_CATEGORY[String(category).toLowerCase()] ?? '2 hrs';

  const info = await db
    .prepare(
      `INSERT INTO service_requests (user_id,vehicle_id,mechanic_id,category,description,status,scheduled_at,estimated_duration)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run(req.auth!.id, vehicleId, chosenMechanicId, category, description, status, scheduledAt ?? null, estimatedDuration);

  // Generate a booking reference now that we have the row id.
  const id = Number(info.lastInsertRowid);
  const bookingRef = `AR-${new Date().getFullYear()}-${String(id).padStart(4, '0')}`;
  await db.prepare('UPDATE service_requests SET booking_ref=? WHERE id=?').run(bookingRef, id);

  await notify('user', req.auth!.id, 'Booking received', `Your ${category} request has been created.`);
  logAction('book_service', `user=${req.auth!.id} category=${category}`);
  res.status(201).json(await db.prepare('SELECT * FROM service_requests WHERE id=?').get(id));
}));

router.post('/services/:id/cancel', requireAuth, h(async (req: AuthedRequest, res) => {
  const row = (await db
    .prepare('SELECT * FROM service_requests WHERE id=? AND user_id=?')
    .get(req.params.id, req.auth!.id)) as any;
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (['completed', 'cancelled'].includes(row.status))
    return res.status(400).json({ error: `Cannot cancel a ${row.status} request` });
  await db.prepare("UPDATE service_requests SET status='cancelled', updated_at=now() WHERE id=?").run(row.id);
  res.json(await db.prepare('SELECT * FROM service_requests WHERE id=?').get(row.id));
}));

router.post('/services/:id/review', requireAuth, h(async (req: AuthedRequest, res) => {
  const { rating, comment } = req.body;
  const r = Number(rating);
  if (!Number.isInteger(r) || r < 1 || r > 5)
    return res.status(400).json({ error: 'rating must be an integer between 1 and 5' });

  const svc = (await db
    .prepare('SELECT * FROM service_requests WHERE id=? AND user_id=?')
    .get(req.params.id, req.auth!.id)) as any;
  if (!svc) return res.status(404).json({ error: 'Service request not found' });
  if (svc.status !== 'completed')
    return res.status(400).json({ error: 'Can only review a completed service' });
  if (svc.rated) return res.status(400).json({ error: 'Service has already been reviewed' });

  const user = (await db.prepare('SELECT name FROM users WHERE id=?').get(req.auth!.id)) as any;
  const info = await db
    .prepare(
      `INSERT INTO reviews (service_request_id,mechanic_id,user_id,user_name,rating,comment)
       VALUES (?,?,?,?,?,?)`,
    )
    .run(svc.id, svc.mechanic_id ?? null, req.auth!.id, user?.name ?? null, r, comment ?? null);

  await db.prepare('UPDATE service_requests SET rated=1 WHERE id=?').run(svc.id);

  // Recompute the mechanic mirror's rating + reviews_count.
  if (svc.mechanic_id != null) {
    const agg = (await db
      .prepare('SELECT AVG(rating) AS avg, COUNT(*) AS cnt FROM reviews WHERE mechanic_id=?')
      .get(svc.mechanic_id)) as any;
    await db.prepare('UPDATE mechanics SET rating=?, reviews_count=? WHERE id=?')
      .run(Math.round((agg.avg ?? r) * 10) / 10, agg.cnt ?? 1, svc.mechanic_id);
  }

  logAction('review_service', `user=${req.auth!.id} sr=${svc.id} rating=${r}`);
  res.status(201).json(await db.prepare('SELECT * FROM reviews WHERE id=?').get(info.lastInsertRowid));
}));

// ── Service discovery (vendor browse + profiles) ──
router.get('/mechanics', requireAuth, h(async (req: AuthedRequest, res) => {
  const { specialization, minRating, available } = req.query;
  const where: string[] = ["approval_status='approved'"];
  const params: any[] = [];
  if (specialization) {
    // ILIKE keeps the search case-insensitive, which is what SQLite's LIKE did.
    where.push('(specialization ILIKE ? OR skills ILIKE ?)');
    params.push(`%${specialization}%`, `%${specialization}%`);
  }
  if (minRating != null && minRating !== '') {
    where.push('rating >= ?');
    params.push(Number(minRating));
  }
  if (available != null && available !== '') {
    where.push('available = ?');
    params.push(available === '1' || available === 'true' ? 1 : 0);
  }
  res.json(
    await db
      .prepare(`SELECT * FROM mechanics WHERE ${where.join(' AND ')} ORDER BY rating DESC`)
      .all(...params),
  );
}));

router.get('/mechanics/:id', requireAuth, h(async (req: AuthedRequest, res) => {
  const mech = await db.prepare('SELECT * FROM mechanics WHERE id=?').get(req.params.id);
  if (!mech) return res.status(404).json({ error: 'Mechanic not found' });
  const reviews = await db
    .prepare('SELECT * FROM reviews WHERE mechanic_id=? ORDER BY created_at DESC, id DESC')
    .all(req.params.id);
  res.json({ ...mech, reviews });
}));

// ── Payments (mock gateway) ────────────────────
router.get('/payments', requireAuth, h(async (req: AuthedRequest, res) => {
  res.json(await db.prepare('SELECT * FROM payments WHERE user_id=? ORDER BY created_at DESC').all(req.auth!.id));
}));

router.post('/payments', requireAuth, h(async (req: AuthedRequest, res) => {
  const { serviceRequestId, method } = req.body;
  const svc = (await db
    .prepare('SELECT * FROM service_requests WHERE id=? AND user_id=?')
    .get(serviceRequestId, req.auth!.id)) as any;
  if (!svc) return res.status(404).json({ error: 'Service request not found' });
  const amount = svc.price ?? 0;
  if (!amount) return res.status(400).json({ error: 'No price set for this service yet' });
  // Mock gateway: always succeeds.
  const ref = `TXN-USR-${Date.now()}`;
  const info = await db
    .prepare(
      `INSERT INTO payments (service_request_id,user_id,amount,method,status,transaction_ref)
       VALUES (?,?,?,?,'paid',?)`,
    )
    .run(serviceRequestId, req.auth!.id, amount, method ?? 'card', ref);
  await notify('user', req.auth!.id, 'Payment successful', `Paid for service #${serviceRequestId}.`);
  res.status(201).json(await db.prepare('SELECT * FROM payments WHERE id=?').get(info.lastInsertRowid));
}));

// ── Issues (with image upload) ─────────────────
router.get('/issues', requireAuth, h(async (req: AuthedRequest, res) => {
  res.json(await db.prepare('SELECT * FROM issues WHERE user_id=? ORDER BY created_at DESC').all(req.auth!.id));
}));

router.post('/issues', requireAuth, upload.single('image'), h(async (req: AuthedRequest, res) => {
  const { title, description, serviceRequestId } = req.body;
  if (!title || !description) return res.status(400).json({ error: 'title and description required' });
  const imagePath = req.file ? `/uploads/${req.file.filename}` : null;
  const info = await db
    .prepare(
      'INSERT INTO issues (user_id,service_request_id,title,description,image_path) VALUES (?,?,?,?,?)',
    )
    .run(req.auth!.id, serviceRequestId || null, title, description, imagePath);
  res.status(201).json(await db.prepare('SELECT * FROM issues WHERE id=?').get(info.lastInsertRowid));
}));

// ── Notifications ──────────────────────────────
router.get('/notifications', requireAuth, h(async (req: AuthedRequest, res) => {
  res.json(
    await db
      .prepare("SELECT * FROM notifications WHERE recipient_role='user' AND recipient_id=? ORDER BY created_at DESC")
      .all(req.auth!.id),
  );
}));

router.post('/notifications/:id/read', requireAuth, h(async (req: AuthedRequest, res) => {
  await db.prepare('UPDATE notifications SET read=1 WHERE id=? AND recipient_id=?').run(req.params.id, req.auth!.id);
  res.json(await db.prepare('SELECT * FROM notifications WHERE id=?').get(req.params.id));
}));
