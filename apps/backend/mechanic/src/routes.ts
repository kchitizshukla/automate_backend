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

const ALLOWED_STATUS = ['pending', 'assigned', 'accepted', 'in_progress', 'completed', 'cancelled'];

// Express 4 does not catch rejected promises, so every async handler is wrapped:
// a rejection becomes next(err) and lands in the shared error handler.
const h =
  (fn: (req: any, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

/** 0/1 for the INTEGER flag columns; null means "leave unchanged". */
const flag = (v: unknown): number | null => (v == null ? null : v ? 1 : 0);

export const router = Router();

// Roadside assistance ("Find Mechanics Nearby") lives in its own module.
router.use(nearbyRouter);

// ── Auth ───────────────────────────────────────
// Registration & Onboarding — captures workshop details; account is 'pending' until admin approval.
async function registerMechanic(req: any, res: any) {
  const {
    name, email, password, phone, skills,
    workshopName, address, certifications, pricingModel, specialization, location, priceFrom,
  } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ error: 'name, email and password are required' });
  const exists = await db.prepare('SELECT id FROM mechanics WHERE email = ?').get(email);
  if (exists) return res.status(409).json({ error: 'Email already registered' });

  const hash = bcrypt.hashSync(password, 10);
  const info = await db
    .prepare(
      `INSERT INTO mechanics
        (name,email,password_hash,phone,skills,workshop_name,address,certifications,pricing_model,specialization,location,price_from,approval_status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'pending')`,
    )
    .run(
      name, email, hash, phone ?? null, skills ?? specialization ?? null,
      workshopName ?? null, address ?? null, certifications ?? null, pricingModel ?? null,
      specialization ?? null, location ?? null, priceFrom ?? null,
    );
  const user = { id: Number(info.lastInsertRowid), name, email, role: 'mechanic' as const };
  logAction('signup', email);
  // Account stays pending; token is issued but login is gated on approval (see /auth/login).
  res.status(201).json({ token: signToken(user), user, pending: true });
}
router.post('/auth/signup', h(registerMechanic));
router.post('/auth/register', h(registerMechanic));

router.post('/auth/login', h(async (req, res) => {
  const { email, password } = req.body;
  const row = (await db.prepare('SELECT * FROM mechanics WHERE email = ?').get(email)) as any;
  if (!row || !bcrypt.compareSync(password || '', row.password_hash))
    return res.status(401).json({ error: 'Invalid credentials' });
  // Only approved mechanics may log in.
  if (row.approval_status !== 'approved')
    return res.status(403).json({ error: 'Your account is awaiting admin approval.' });
  const user = { id: row.id, name: row.name, email: row.email, role: 'mechanic' as const };
  logAction('login', email);
  res.json({ token: signToken(user), user });
}));

router.get('/auth/me', requireAuth, (req: AuthedRequest, res) => res.json(req.auth));

// ── Profile ────────────────────────────────────
const PROFILE_COLS =
  'id,name,email,phone,skills,available,rating,approval_status,workshop_name,address,certifications,pricing_model,location,specialization,price_from,created_at';

router.get('/profile', requireAuth, h(async (req: AuthedRequest, res) => {
  res.json(await db.prepare(`SELECT ${PROFILE_COLS} FROM mechanics WHERE id = ?`).get(req.auth!.id));
}));

router.put('/profile', requireAuth, h(async (req: AuthedRequest, res) => {
  const { name, phone, skills, available, workshopName, address, certifications, pricingModel, location, specialization, priceFrom } = req.body;
  await db.prepare(
    `UPDATE mechanics SET
       name=COALESCE(?,name), phone=COALESCE(?,phone), skills=COALESCE(?,skills),
       available=COALESCE(?,available), workshop_name=COALESCE(?,workshop_name),
       address=COALESCE(?,address), certifications=COALESCE(?,certifications),
       pricing_model=COALESCE(?,pricing_model), location=COALESCE(?,location),
       specialization=COALESCE(?,specialization), price_from=COALESCE(?,price_from)
     WHERE id=?`,
  ).run(
    name ?? null, phone ?? null, skills ?? null, flag(available), workshopName ?? null,
    address ?? null, certifications ?? null, pricingModel ?? null, location ?? null,
    specialization ?? null, priceFrom ?? null, req.auth!.id,
  );
  res.json(await db.prepare(`SELECT ${PROFILE_COLS} FROM mechanics WHERE id=?`).get(req.auth!.id));
}));

// ── Service Management (CRUD) ──────────────────
router.get('/services', requireAuth, h(async (req: AuthedRequest, res) => {
  res.json(await db.prepare('SELECT * FROM services WHERE mechanic_id=? ORDER BY created_at DESC').all(req.auth!.id));
}));

router.post('/services', requireAuth, h(async (req: AuthedRequest, res) => {
  const { name, description, price, duration, available, isPromotion, promoLabel } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const info = await db
    .prepare('INSERT INTO services (mechanic_id,name,description,price,duration,available,is_promotion,promo_label) VALUES (?,?,?,?,?,?,?,?)')
    .run(req.auth!.id, name, description ?? null, Number(price) || 0, duration ?? null, available === false ? 0 : 1, isPromotion ? 1 : 0, promoLabel ?? null);
  logAction('create_service', `mechanic=${req.auth!.id} service=${name}`);
  res.status(201).json(await db.prepare('SELECT * FROM services WHERE id=?').get(info.lastInsertRowid));
}));

router.put('/services/:id', requireAuth, h(async (req: AuthedRequest, res) => {
  const row = (await db
    .prepare('SELECT * FROM services WHERE id=? AND mechanic_id=?')
    .get(req.params.id, req.auth!.id)) as any;
  if (!row) return res.status(404).json({ error: 'Service not found' });
  const { name, description, price, duration, available, isPromotion, promoLabel } = req.body;
  await db.prepare(
    `UPDATE services SET
       name=COALESCE(?,name), description=COALESCE(?,description), price=COALESCE(?,price),
       duration=COALESCE(?,duration), available=COALESCE(?,available),
       is_promotion=COALESCE(?,is_promotion), promo_label=COALESCE(?,promo_label)
     WHERE id=? AND mechanic_id=?`,
  ).run(
    name ?? null, description ?? null, price != null ? Number(price) : null, duration ?? null,
    flag(available), flag(isPromotion), promoLabel ?? null,
    row.id, req.auth!.id,
  );
  res.json(await db.prepare('SELECT * FROM services WHERE id=?').get(row.id));
}));

router.delete('/services/:id', requireAuth, h(async (req: AuthedRequest, res) => {
  const row = await db.prepare('SELECT id FROM services WHERE id=? AND mechanic_id=?').get(req.params.id, req.auth!.id);
  if (!row) return res.status(404).json({ error: 'Service not found' });
  await db.prepare('DELETE FROM services WHERE id=? AND mechanic_id=?').run(req.params.id, req.auth!.id);
  res.json({ ok: true, id: Number(req.params.id) });
}));

// ── Bookings (alias of jobs — incoming requests) ──
router.get('/bookings', requireAuth, h(async (req: AuthedRequest, res) => {
  res.json(await db.prepare('SELECT * FROM jobs WHERE mechanic_id=? ORDER BY created_at DESC').all(req.auth!.id));
}));

// ── Payments ───────────────────────────────────
router.get('/payments', requireAuth, h(async (req: AuthedRequest, res) => {
  res.json(await db.prepare('SELECT * FROM payments WHERE mechanic_id=? ORDER BY created_at DESC').all(req.auth!.id));
}));

// ── Feedback (ratings + reviews) ───────────────
router.get('/feedback', requireAuth, h(async (req: AuthedRequest, res) => {
  const id = req.auth!.id;
  const reviews = await db.prepare('SELECT * FROM reviews WHERE mechanic_id=? ORDER BY created_at DESC').all(id);
  const agg = (await db
    .prepare('SELECT COUNT(*) AS count, AVG(rating) AS avg FROM reviews WHERE mechanic_id=?')
    .get(id)) as any;
  res.json({ averageRating: Number(agg.avg ?? 0), count: agg.count ?? 0, reviews });
}));

// ── Jobs ───────────────────────────────────────
router.get('/jobs', requireAuth, h(async (req: AuthedRequest, res) => {
  res.json(await db.prepare('SELECT * FROM jobs WHERE mechanic_id=? ORDER BY created_at DESC').all(req.auth!.id));
}));

router.get('/jobs/:id', requireAuth, h(async (req: AuthedRequest, res) => {
  const row = await db.prepare('SELECT * FROM jobs WHERE id=? AND mechanic_id=?').get(req.params.id, req.auth!.id);
  if (!row) return res.status(404).json({ error: 'Job not found' });
  res.json(row);
}));

router.post('/jobs/:id/accept', requireAuth, h(async (req: AuthedRequest, res) => {
  const row = (await db
    .prepare('SELECT * FROM jobs WHERE id=? AND mechanic_id=?')
    .get(req.params.id, req.auth!.id)) as any;
  if (!row) return res.status(404).json({ error: 'Job not found' });
  if (row.status !== 'assigned')
    return res.status(400).json({ error: `Cannot accept a ${row.status} job` });
  await db.prepare("UPDATE jobs SET status='accepted', updated_at=now() WHERE id=?").run(row.id);
  await db.prepare('INSERT INTO job_updates (job_id,type,message) VALUES (?,?,?)')
    .run(row.id, 'status_change', 'Status changed to accepted');
  await notify('mechanic', req.auth!.id, 'Job accepted', `You accepted job #${row.id}.`);
  logAction('accept_job', `mechanic=${req.auth!.id} job=${row.id}`);
  res.json(await db.prepare('SELECT * FROM jobs WHERE id=?').get(row.id));
}));

router.post('/jobs/:id/reject', requireAuth, h(async (req: AuthedRequest, res) => {
  const row = (await db
    .prepare('SELECT * FROM jobs WHERE id=? AND mechanic_id=?')
    .get(req.params.id, req.auth!.id)) as any;
  if (!row) return res.status(404).json({ error: 'Job not found' });
  if (['completed', 'cancelled'].includes(row.status))
    return res.status(400).json({ error: `Cannot reject a ${row.status} job` });
  await db.prepare("UPDATE jobs SET status='cancelled', updated_at=now() WHERE id=?").run(row.id);
  await db.prepare('INSERT INTO job_updates (job_id,type,message) VALUES (?,?,?)')
    .run(row.id, 'status_change', 'Status changed to cancelled (rejected by mechanic)');
  await notify('mechanic', req.auth!.id, 'Job rejected', `You rejected job #${row.id}.`);
  logAction('reject_job', `mechanic=${req.auth!.id} job=${row.id}`);
  res.json(await db.prepare('SELECT * FROM jobs WHERE id=?').get(row.id));
}));

router.post('/jobs/:id/status', requireAuth, h(async (req: AuthedRequest, res) => {
  const { status, notes } = req.body;
  if (!status || !ALLOWED_STATUS.includes(status))
    return res.status(400).json({ error: `status must be one of ${ALLOWED_STATUS.join(', ')}` });
  const row = (await db
    .prepare('SELECT * FROM jobs WHERE id=? AND mechanic_id=?')
    .get(req.params.id, req.auth!.id)) as any;
  if (!row) return res.status(404).json({ error: 'Job not found' });
  await db.prepare("UPDATE jobs SET status=?, notes=COALESCE(?,notes), updated_at=now() WHERE id=?")
    .run(status, notes ?? null, row.id);
  await db.prepare('INSERT INTO job_updates (job_id,type,message) VALUES (?,?,?)')
    .run(row.id, 'status_change', `Status changed to ${status}`);
  await notify('mechanic', req.auth!.id, 'Job updated', `Job #${row.id} status is now ${status}.`);
  logAction('update_status', `mechanic=${req.auth!.id} job=${row.id} status=${status}`);
  res.json(await db.prepare('SELECT * FROM jobs WHERE id=?').get(row.id));
}));

router.get('/jobs/:id/updates', requireAuth, h(async (req: AuthedRequest, res) => {
  const job = await db.prepare('SELECT id FROM jobs WHERE id=? AND mechanic_id=?').get(req.params.id, req.auth!.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(await db.prepare('SELECT * FROM job_updates WHERE job_id=? ORDER BY created_at ASC').all(req.params.id));
}));

router.post('/jobs/:id/images', requireAuth, upload.single('image'), h(async (req: AuthedRequest, res) => {
  const row = (await db
    .prepare('SELECT * FROM jobs WHERE id=? AND mechanic_id=?')
    .get(req.params.id, req.auth!.id)) as any;
  if (!row) return res.status(404).json({ error: 'Job not found' });
  if (!req.file) return res.status(400).json({ error: 'image file is required' });
  const imagePath = `/uploads/${req.file.filename}`;
  const info = await db
    .prepare('INSERT INTO job_updates (job_id,type,message,image_path) VALUES (?,?,?,?)')
    .run(row.id, 'image', req.body.message ?? null, imagePath);
  logAction('upload_image', `mechanic=${req.auth!.id} job=${row.id}`);
  res.status(201).json(await db.prepare('SELECT * FROM job_updates WHERE id=?').get(info.lastInsertRowid));
}));

router.post('/jobs/:id/reschedule', requireAuth, h(async (req: AuthedRequest, res) => {
  const { scheduledAt } = req.body;
  if (!scheduledAt) return res.status(400).json({ error: 'scheduledAt is required' });
  const row = (await db
    .prepare('SELECT * FROM jobs WHERE id=? AND mechanic_id=?')
    .get(req.params.id, req.auth!.id)) as any;
  if (!row) return res.status(404).json({ error: 'Job not found' });
  if (['completed', 'cancelled'].includes(row.status))
    return res.status(400).json({ error: `Cannot reschedule a ${row.status} job` });
  await db.prepare("UPDATE jobs SET scheduled_at=?, updated_at=now() WHERE id=?").run(scheduledAt, row.id);
  await db.prepare('INSERT INTO job_updates (job_id,type,message) VALUES (?,?,?)')
    .run(row.id, 'note', `Job rescheduled to ${scheduledAt}`);
  await notify('mechanic', req.auth!.id, 'Job rescheduled', `Job #${row.id} is now scheduled for ${scheduledAt}.`);
  logAction('reschedule_job', `mechanic=${req.auth!.id} job=${row.id} scheduledAt=${scheduledAt}`);
  res.json(await db.prepare('SELECT * FROM jobs WHERE id=?').get(row.id));
}));

// ── Earnings ───────────────────────────────────
router.get('/earnings', requireAuth, h(async (req: AuthedRequest, res) => {
  const id = req.auth!.id;
  const scalar = async (sql: string, ...params: any[]) =>
    ((await db.prepare(sql).get(...params)) as any)?.v ?? 0;

  const totalEarned = await scalar("SELECT COALESCE(SUM(price),0) AS v FROM jobs WHERE mechanic_id=? AND status='completed'", id);
  const pendingPayout = await scalar("SELECT COALESCE(SUM(price),0) AS v FROM jobs WHERE mechanic_id=? AND status IN ('in_progress','accepted')", id);
  const completedJobs = await scalar("SELECT COUNT(*) AS v FROM jobs WHERE mechanic_id=? AND status='completed'", id);
  const avgReview = ((await db.prepare('SELECT AVG(rating) AS v FROM reviews WHERE mechanic_id=?').get(id)) as any)?.v;
  const mechRating = await scalar('SELECT rating AS v FROM mechanics WHERE id=?', id);
  const averageRating = avgReview != null ? Number(avgReview) : mechRating;
  // to_char is the Postgres equivalent of SQLite's strftime('%Y-%m', ...).
  const monthly = await db
    .prepare(
      `SELECT to_char(created_at, 'YYYY-MM') AS month, COALESCE(SUM(price),0) AS amount
       FROM jobs WHERE mechanic_id=? AND status='completed'
       GROUP BY month ORDER BY month`,
    )
    .all(id);
  res.json({ totalEarned, pendingPayout, completedJobs, averageRating, monthly });
}));

// ── Reviews ────────────────────────────────────
router.get('/reviews', requireAuth, h(async (req: AuthedRequest, res) => {
  res.json(await db.prepare('SELECT * FROM reviews WHERE mechanic_id=? ORDER BY created_at DESC').all(req.auth!.id));
}));

// ── Notifications ──────────────────────────────
router.get('/notifications', requireAuth, h(async (req: AuthedRequest, res) => {
  res.json(
    await db
      .prepare("SELECT * FROM notifications WHERE recipient_role='mechanic' AND recipient_id=? ORDER BY created_at DESC")
      .all(req.auth!.id),
  );
}));

router.post('/notifications/:id/read', requireAuth, h(async (req: AuthedRequest, res) => {
  await db.prepare('UPDATE notifications SET read=1 WHERE id=? AND recipient_id=?').run(req.params.id, req.auth!.id);
  res.json(await db.prepare('SELECT * FROM notifications WHERE id=?').get(req.params.id));
}));
