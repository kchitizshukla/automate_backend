import { Router, type Request, type Response, type NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import { db } from './db.js';
import { signToken, requireAuth, type AuthedRequest } from './auth.js';
import { logAction, notify } from './middleware.js';

// Express 4 does not catch rejected promises, so every async handler is wrapped:
// a rejection becomes next(err) and lands in the shared error handler.
const h =
  (fn: (req: any, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

export const router = Router();

// ── Auth ───────────────────────────────────────
router.post('/auth/signup', h(async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ error: 'name, email and password are required' });
  const exists = await db.prepare('SELECT id FROM admins WHERE email = ?').get(email);
  if (exists) return res.status(409).json({ error: 'Email already registered' });

  const hash = bcrypt.hashSync(password, 10);
  const info = await db
    .prepare("INSERT INTO admins (name,email,password_hash,role) VALUES (?,?,?,'admin')")
    .run(name, email, hash);
  const admin = { id: Number(info.lastInsertRowid), name, email, role: 'admin' as const };
  logAction('signup', email);
  res.status(201).json({ token: signToken(admin), user: admin });
}));

router.post('/auth/login', h(async (req, res) => {
  const { email, password } = req.body;
  const row = (await db.prepare('SELECT * FROM admins WHERE email = ?').get(email)) as any;
  if (!row || !bcrypt.compareSync(password || '', row.password_hash))
    return res.status(401).json({ error: 'Invalid credentials' });
  const admin = { id: row.id, name: row.name, email: row.email, role: 'admin' as const };
  logAction('login', email);
  res.json({ token: signToken(admin), user: admin });
}));

router.get('/auth/me', requireAuth, (req: AuthedRequest, res) => res.json(req.auth));

// ── Profile ────────────────────────────────────
router.get('/profile', requireAuth, h(async (req: AuthedRequest, res) => {
  const row = await db
    .prepare('SELECT id,name,email,role,created_at FROM admins WHERE id = ?')
    .get(req.auth!.id);
  res.json(row);
}));

router.put('/profile', requireAuth, h(async (req: AuthedRequest, res) => {
  const { name } = req.body;
  await db.prepare('UPDATE admins SET name=COALESCE(?,name) WHERE id=?').run(name ?? null, req.auth!.id);
  res.json(await db.prepare('SELECT id,name,email,role FROM admins WHERE id=?').get(req.auth!.id));
}));

// ── Users overview ─────────────────────────────
router.get('/admin/users', requireAuth, h(async (_req, res) => {
  res.json(await db.prepare('SELECT * FROM managed_users ORDER BY id ASC').all());
}));

// ── Mechanics overview ─────────────────────────
router.get('/admin/mechanics', requireAuth, h(async (_req, res) => {
  res.json(await db.prepare('SELECT * FROM managed_mechanics ORDER BY id ASC').all());
}));

// ── Mechanic approval ──────────────────────────
router.post('/admin/mechanics/:id/approve', requireAuth, h(async (req: AuthedRequest, res) => {
  const mech = (await db.prepare('SELECT * FROM managed_mechanics WHERE id=?').get(req.params.id)) as any;
  if (!mech) return res.status(404).json({ error: 'Mechanic not found' });
  await db.prepare("UPDATE managed_mechanics SET approval_status='approved' WHERE id=?").run(req.params.id);
  await db.prepare('INSERT INTO system_logs (actor_role,actor_id,action,detail) VALUES (?,?,?,?)')
    .run('admin', req.auth!.id, 'approve_mechanic', `Mechanic ${mech.id} (${mech.name}) approved`);
  await notify('admin', req.auth!.id, 'Mechanic approved', `${mech.name} has been approved.`);
  logAction('approve_mechanic', `mechanic=${mech.id}`);
  res.json(await db.prepare('SELECT * FROM managed_mechanics WHERE id=?').get(req.params.id));
}));

router.post('/admin/mechanics/:id/reject', requireAuth, h(async (req: AuthedRequest, res) => {
  const mech = (await db.prepare('SELECT * FROM managed_mechanics WHERE id=?').get(req.params.id)) as any;
  if (!mech) return res.status(404).json({ error: 'Mechanic not found' });
  await db.prepare("UPDATE managed_mechanics SET approval_status='rejected' WHERE id=?").run(req.params.id);
  await db.prepare('INSERT INTO system_logs (actor_role,actor_id,action,detail) VALUES (?,?,?,?)')
    .run('admin', req.auth!.id, 'reject_mechanic', `Mechanic ${mech.id} (${mech.name}) rejected`);
  await notify('admin', req.auth!.id, 'Mechanic rejected', `${mech.name} has been rejected.`);
  logAction('reject_mechanic', `mechanic=${mech.id}`);
  res.json(await db.prepare('SELECT * FROM managed_mechanics WHERE id=?').get(req.params.id));
}));

// ── Payments ───────────────────────────────────
router.get('/admin/payments', requireAuth, h(async (_req, res) => {
  res.json(await db.prepare('SELECT * FROM managed_payments ORDER BY created_at DESC, id DESC').all());
}));

// ── Reconciliation ─────────────────────────────
router.get('/admin/reconciliation', requireAuth, h(async (_req, res) => {
  const sum = async (status: string) =>
    ((await db
      .prepare('SELECT COALESCE(SUM(amount),0) AS c FROM managed_payments WHERE status=?')
      .get(status)) as { c: number }).c;
  const collected = await sum('paid');
  res.json({
    collected,
    pending: await sum('pending'),
    refunded: await sum('refunded'),
    transactions: ((await db.prepare('SELECT COUNT(*) AS c FROM managed_payments').get()) as { c: number }).c,
    payoutDue: collected,
  });
}));

// ── Services overview ──────────────────────────
router.get('/admin/services', requireAuth, h(async (_req, res) => {
  res.json(await db.prepare('SELECT * FROM service_overview ORDER BY created_at DESC, id DESC').all());
}));

// ── Assign a job ───────────────────────────────
router.post('/admin/assign', requireAuth, h(async (req: AuthedRequest, res) => {
  const { serviceRequestId, mechanicId } = req.body;
  if (!serviceRequestId || !mechanicId)
    return res.status(400).json({ error: 'serviceRequestId and mechanicId required' });
  const svc = (await db
    .prepare('SELECT * FROM service_overview WHERE service_request_id=?')
    .get(serviceRequestId)) as any;
  if (!svc) return res.status(404).json({ error: 'Service request not found' });
  const mech = (await db.prepare('SELECT * FROM managed_mechanics WHERE id=?').get(mechanicId)) as any;
  if (!mech) return res.status(404).json({ error: 'Mechanic not found' });

  // Append-only: a reassignment adds a row here and overwrites the overview,
  // so the full assignment history survives.
  const info = await db
    .prepare('INSERT INTO job_assignments (service_request_id,mechanic_id,assigned_by) VALUES (?,?,?)')
    .run(serviceRequestId, mechanicId, req.auth!.id);
  await db.prepare("UPDATE service_overview SET status='assigned', mechanic_id=? WHERE service_request_id=?")
    .run(mechanicId, serviceRequestId);
  await db.prepare('INSERT INTO system_logs (actor_role,actor_id,action,detail) VALUES (?,?,?,?)')
    .run('admin', req.auth!.id, 'assign_job', `SR#${serviceRequestId} assigned to mechanic ${mechanicId}`);
  await notify('admin', req.auth!.id, 'Job assigned', `SR#${serviceRequestId} assigned to ${mech.name}.`);
  logAction('assign_job', `sr=${serviceRequestId} mechanic=${mechanicId}`);
  res.status(201).json(await db.prepare('SELECT * FROM job_assignments WHERE id=?').get(info.lastInsertRowid));
}));

// ── Analytics ──────────────────────────────────
router.get('/admin/analytics', requireAuth, h(async (_req, res) => {
  const c = async (sql: string) => ((await db.prepare(sql).get()) as { c: number }).c;
  res.json({
    totalUsers: await c('SELECT COUNT(*) AS c FROM managed_users'),
    totalMechanics: await c('SELECT COUNT(*) AS c FROM managed_mechanics'),
    totalServices: await c('SELECT COUNT(*) AS c FROM service_overview'),
    pendingServices: await c("SELECT COUNT(*) AS c FROM service_overview WHERE status='pending'"),
    completedServices: await c("SELECT COUNT(*) AS c FROM service_overview WHERE status='completed'"),
    totalRevenue: await c("SELECT COALESCE(SUM(price),0) AS c FROM service_overview WHERE status='completed'"),
    availableMechanics: await c('SELECT COUNT(*) AS c FROM managed_mechanics WHERE available=1'),
    approvedMechanics: await c("SELECT COUNT(*) AS c FROM managed_mechanics WHERE approval_status='approved'"),
    pendingApprovals: await c("SELECT COUNT(*) AS c FROM managed_mechanics WHERE approval_status='pending'"),
  });
}));

// ── System logs ────────────────────────────────
router.get('/admin/logs', requireAuth, h(async (_req, res) => {
  res.json(await db.prepare('SELECT * FROM system_logs ORDER BY created_at DESC, id DESC').all());
}));

// ── Notifications ──────────────────────────────
router.get('/notifications', requireAuth, h(async (req: AuthedRequest, res) => {
  res.json(
    await db
      .prepare("SELECT * FROM notifications WHERE recipient_role='admin' AND recipient_id=? ORDER BY created_at DESC")
      .all(req.auth!.id),
  );
}));

router.post('/notifications/:id/read', requireAuth, h(async (req: AuthedRequest, res) => {
  await db.prepare('UPDATE notifications SET read=1 WHERE id=? AND recipient_id=?').run(req.params.id, req.auth!.id);
  res.json(await db.prepare('SELECT * FROM notifications WHERE id=?').get(req.params.id));
}));
