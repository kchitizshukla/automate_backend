// ──────────────────────────────────────────────
// Vehicles — master data + the user's garage.
//
// The master endpoints are the whole point of this module: the web and mobile
// apps hold no vehicle taxonomy of their own, they walk this hierarchy
//
//   type → category → manufacturer → model → variant → fuel type
//
// one dependent request at a time. Anything inserted into the VEHICLE_* tables
// shows up in both apps on the next request, with no frontend deploy.
//
// Every list endpoint returns active rows only, in display_order.
// ──────────────────────────────────────────────
import { Router, type Request, type Response, type NextFunction } from 'express';
import {
  normalizeRegistrationNo,
  resolveRegistrationRule,
  validateRegistrationNo,
  validateVehicleYear,
} from '@automate/shared-utils';
import type { RegistrationRule } from '@automate/shared-types';
import { db } from './db.js';
import { requireAuth, type AuthedRequest } from './auth.js';
import { logAction } from './middleware.js';

const h =
  (fn: (req: any, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

export const vehiclesRouter = Router();

/**
 * The "Other / Not listed" escape hatch. It is synthesised here rather than
 * stored as a row per category, so a category added tomorrow gets one for free.
 * Picking it stores free text in the matching `custom_*` column.
 */
export const OTHER_OPTION_ID = -1;

const otherOption = (label = 'Other / Not listed') => ({
  id: OTHER_OPTION_ID,
  name: label,
  code: 'other',
  description: 'Not in the list — you can type it in',
  icon: '➕',
  displayOrder: 999_999,
  isActive: true,
  isOther: true,
});

/* ── Response cache ───────────────────────────
   Master data changes rarely and every dependent dropdown hits these paths, so
   a short in-process TTL keeps the picker instant without ever going stale for
   long. Admin inserts appear after at most one TTL window. */
// 0 disables caching outright, which is why this is not a `||` fallback.
const rawTtl = process.env.VEHICLE_MASTER_CACHE_TTL_MS?.trim();
const CACHE_TTL_MS = rawTtl && Number.isFinite(Number(rawTtl)) ? Number(rawTtl) : 60_000;
const cache = new Map<string, { at: number; value: unknown }>();

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value as T;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** Called after any write that could change what the master lists return. */
export function clearVehicleMasterCache() {
  cache.clear();
}

/* ── Row mapping ─────────────────────────────── */

const bool = (v: any) => v === 1 || v === true || v === '1';
const int = (v: any): number | null => (v == null || v === '' ? null : Number(v));

function masterRow(r: any) {
  return {
    id: r.id,
    name: r.name,
    code: r.code,
    description: r.description ?? null,
    icon: r.icon ?? null,
    displayOrder: r.display_order,
    isActive: bool(r.is_active),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function ruleRow(r: any): RegistrationRule {
  return {
    id: r.id,
    vehicleTypeId: int(r.vehicle_type_id),
    vehicleCategoryId: int(r.vehicle_category_id),
    pattern: r.pattern ?? null,
    placeholder: r.placeholder ?? null,
    helpText: r.help_text ?? null,
    minLength: r.min_length,
    maxLength: r.max_length,
    isRequired: bool(r.is_required),
  };
}

/** Clamped so a client cannot ask for the whole model table in one call. */
function paging(req: Request) {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 100));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

const searchTerm = (req: Request) => String(req.query.q ?? '').trim();

function pageResult<T>(items: T[], total: number, page: number, pageSize: number) {
  return { items, total, page, pageSize, hasMore: page * pageSize < total };
}

/* ══════════════════════════════════════════════
   MASTER DATA
   ══════════════════════════════════════════════ */

// GET /api/vehicles/types
vehiclesRouter.get('/vehicles/types', requireAuth, h(async (_req, res) => {
  res.json(
    await cached('types', async () => {
      const rows = await db
        .prepare(
          `SELECT t.*, COUNT(c.id)::int AS category_count
             FROM vehicle_types t
             LEFT JOIN vehicle_categories c ON c.vehicle_type_id = t.id AND c.is_active = 1
            WHERE t.is_active = 1
            GROUP BY t.id
            ORDER BY t.display_order, t.name`,
        )
        .all();
      return rows.map((r: any) => ({ ...masterRow(r), categoryCount: r.category_count }));
    }),
  );
}));

// GET /api/vehicles/categories?typeId=
vehiclesRouter.get('/vehicles/categories', requireAuth, h(async (req, res) => {
  const typeId = int(req.query.typeId);
  res.json(
    await cached(`categories:${typeId ?? 'all'}`, async () => {
      const rows = await db
        .prepare(
          `SELECT c.*, t.name AS type_name, t.code AS type_code
             FROM vehicle_categories c
             JOIN vehicle_types t ON t.id = c.vehicle_type_id AND t.is_active = 1
            WHERE c.is_active = 1 AND (?::int IS NULL OR c.vehicle_type_id = ?::int)
            ORDER BY c.display_order, c.name`,
        )
        .all(typeId, typeId);
      return rows.map((r: any) => ({
        ...masterRow(r),
        vehicleTypeId: r.vehicle_type_id,
        vehicleTypeName: r.type_name,
        vehicleTypeCode: r.type_code,
        isElectric: bool(r.is_electric),
      }));
    }),
  );
}));

// GET /api/vehicles/manufacturers?categoryId=&typeId=&q=&page=&pageSize=
vehiclesRouter.get('/vehicles/manufacturers', requireAuth, h(async (req, res) => {
  const categoryId = int(req.query.categoryId);
  const typeId = int(req.query.typeId);
  const q = searchTerm(req);
  const { page, pageSize, offset } = paging(req);

  const where: string[] = ['mf.is_active = 1'];
  const params: any[] = [];
  let joins = '';
  if (categoryId != null) {
    joins = `JOIN vehicle_category_manufacturers cm
               ON cm.vehicle_manufacturer_id = mf.id AND cm.is_active = 1
             JOIN vehicle_categories c ON c.id = cm.vehicle_category_id AND c.is_active = 1`;
    where.push('c.id = ?');
    params.push(categoryId);
  } else if (typeId != null) {
    joins = `JOIN vehicle_category_manufacturers cm
               ON cm.vehicle_manufacturer_id = mf.id AND cm.is_active = 1
             JOIN vehicle_categories c ON c.id = cm.vehicle_category_id AND c.is_active = 1`;
    where.push('c.vehicle_type_id = ?');
    params.push(typeId);
  }
  if (q) {
    where.push('mf.name ILIKE ?');
    params.push(`%${q}%`);
  }

  const sql = `FROM vehicle_manufacturers mf ${joins} WHERE ${where.join(' AND ')}`;
  const load = async () => {
    const total = ((await db.prepare(`SELECT COUNT(DISTINCT mf.id)::int AS n ${sql}`).get(...params)) as any).n;
    const rows = await db
      .prepare(
        `SELECT DISTINCT mf.id, mf.name, mf.code, mf.description, mf.logo_url,
                mf.display_order, mf.is_active
           ${sql}
          ORDER BY mf.display_order, mf.name
          LIMIT ? OFFSET ?`,
      )
      .all(...params, pageSize, offset);
    const items: any[] = rows.map((r: any) => ({
      ...masterRow(r),
      logoUrl: r.logo_url ?? null,
      vehicleCategoryId: categoryId ?? undefined,
    }));
    // The escape hatch always sits last, and only on the final page.
    if (page * pageSize >= total) items.push({ ...otherOption('Other manufacturer'), logoUrl: null });
    return pageResult(items, total, page, pageSize);
  };

  // Only unfiltered/browse requests are worth caching; searches are one-offs.
  res.json(q ? await load() : await cached(`mfr:${categoryId ?? 'x'}:${typeId ?? 'x'}:${page}:${pageSize}`, load));
}));

// GET /api/vehicles/models?manufacturerId=&categoryId=&q=&page=&pageSize=
vehiclesRouter.get('/vehicles/models', requireAuth, h(async (req, res) => {
  const manufacturerId = int(req.query.manufacturerId);
  const categoryId = int(req.query.categoryId);
  const q = searchTerm(req);
  const { page, pageSize, offset } = paging(req);

  const where = ['vm.is_active = 1', 'mf.is_active = 1', 'c.is_active = 1'];
  const params: any[] = [];
  if (manufacturerId != null && manufacturerId !== OTHER_OPTION_ID) {
    where.push('vm.vehicle_manufacturer_id = ?');
    params.push(manufacturerId);
  }
  if (categoryId != null) {
    where.push('vm.vehicle_category_id = ?');
    params.push(categoryId);
  }
  if (q) {
    where.push('vm.name ILIKE ?');
    params.push(`%${q}%`);
  }

  const sql = `FROM vehicle_models vm
                 JOIN vehicle_manufacturers mf ON mf.id = vm.vehicle_manufacturer_id
                 JOIN vehicle_categories    c  ON c.id  = vm.vehicle_category_id
                WHERE ${where.join(' AND ')}`;

  const load = async () => {
    const total = ((await db.prepare(`SELECT COUNT(*)::int AS n ${sql}`).get(...params)) as any).n;
    const rows = await db
      .prepare(
        `SELECT vm.*, mf.name AS manufacturer_name, c.name AS category_name ${sql}
          ORDER BY vm.display_order, vm.name
          LIMIT ? OFFSET ?`,
      )
      .all(...params, pageSize, offset);
    const items: any[] = rows.map((r: any) => ({
      ...masterRow(r),
      manufacturerId: r.vehicle_manufacturer_id,
      manufacturerName: r.manufacturer_name,
      vehicleCategoryId: r.vehicle_category_id,
      vehicleCategoryName: r.category_name,
    }));
    if (page * pageSize >= total) items.push(otherOption('Other model'));
    return pageResult(items, total, page, pageSize);
  };

  res.json(
    q ? await load() : await cached(`models:${manufacturerId ?? 'x'}:${categoryId ?? 'x'}:${page}:${pageSize}`, load),
  );
}));

// GET /api/vehicles/variants?modelId=
vehiclesRouter.get('/vehicles/variants', requireAuth, h(async (req, res) => {
  const modelId = int(req.query.modelId);
  if (modelId == null || modelId === OTHER_OPTION_ID) {
    // No model chosen (or "Other") — variant can only be free text.
    return res.json(pageResult([otherOption('Other variant')], 0, 1, 100));
  }
  res.json(
    await cached(`variants:${modelId}`, async () => {
      const rows = await db
        .prepare(
          `SELECT v.*, m.name AS model_name
             FROM vehicle_variants v
             JOIN vehicle_models m ON m.id = v.vehicle_model_id AND m.is_active = 1
            WHERE v.is_active = 1 AND v.vehicle_model_id = ?
            ORDER BY v.display_order, v.name`,
        )
        .all(modelId);
      const items: any[] = rows.map((r: any) => ({
        ...masterRow(r),
        vehicleModelId: r.vehicle_model_id,
        vehicleModelName: r.model_name,
      }));
      items.push(otherOption('Other variant'));
      return pageResult(items, rows.length, 1, 100);
    }),
  );
}));

// GET /api/vehicles/fuel-types?modelId=&categoryId=
// Narrowed by the model when the master data says so, otherwise every active
// power type — so a new model is usable the moment it is inserted.
vehiclesRouter.get('/vehicles/fuel-types', requireAuth, h(async (req, res) => {
  const modelId = int(req.query.modelId);
  const categoryId = int(req.query.categoryId);
  res.json(
    await cached(`fuel:${modelId ?? 'x'}:${categoryId ?? 'x'}`, async () => {
      let rows: any[] = [];
      if (modelId != null && modelId !== OTHER_OPTION_ID) {
        rows = await db
          .prepare(
            `SELECT ft.* FROM vehicle_fuel_types ft
               JOIN vehicle_model_fuel_types mft
                 ON mft.vehicle_fuel_type_id = ft.id AND mft.is_active = 1
              WHERE ft.is_active = 1 AND mft.vehicle_model_id = ?
              ORDER BY ft.display_order, ft.name`,
          )
          .all(modelId);
      }
      if (!rows.length && categoryId != null) {
        // An electric-by-definition category never offers petrol.
        const cat: any = await db
          .prepare('SELECT is_electric FROM vehicle_categories WHERE id = ? AND is_active = 1')
          .get(categoryId);
        if (cat && bool(cat.is_electric)) {
          rows = await db
            .prepare(
              `SELECT * FROM vehicle_fuel_types
                WHERE is_active = 1 AND is_electric = 1
                ORDER BY display_order, name`,
            )
            .all();
        }
      }
      if (!rows.length) {
        rows = await db
          .prepare('SELECT * FROM vehicle_fuel_types WHERE is_active = 1 ORDER BY display_order, name')
          .all();
      }
      return rows.map((r: any) => ({ ...masterRow(r), isElectric: bool(r.is_electric) }));
    }),
  );
}));

// GET /api/vehicles/registration-rules
vehiclesRouter.get('/vehicles/registration-rules', requireAuth, h(async (_req, res) => {
  res.json(await loadRules());
}));

async function loadRules(): Promise<RegistrationRule[]> {
  return cached('rules', async () => {
    const rows = await db
      .prepare(
        `SELECT * FROM vehicle_registration_rules
          WHERE is_active = 1
          ORDER BY display_order, id`,
      )
      .all();
    return rows.map(ruleRow);
  });
}

/**
 * GET /api/vehicles/master — one round trip for everything the add-vehicle
 * form needs before the user has touched a control. Mobile especially benefits
 * from not making three requests to render an empty form.
 */
vehiclesRouter.get('/vehicles/master', requireAuth, h(async (_req, res) => {
  const [types, fuelTypes, registrationRules] = await Promise.all([
    cached('types', async () => {
      const rows = await db
        .prepare(
          `SELECT t.*, COUNT(c.id)::int AS category_count
             FROM vehicle_types t
             LEFT JOIN vehicle_categories c ON c.vehicle_type_id = t.id AND c.is_active = 1
            WHERE t.is_active = 1 GROUP BY t.id ORDER BY t.display_order, t.name`,
        )
        .all();
      return rows.map((r: any) => ({ ...masterRow(r), categoryCount: r.category_count }));
    }),
    cached('fuel:x:x', async () => {
      const rows = await db
        .prepare('SELECT * FROM vehicle_fuel_types WHERE is_active = 1 ORDER BY display_order, name')
        .all();
      return rows.map((r: any) => ({ ...masterRow(r), isElectric: bool(r.is_electric) }));
    }),
    loadRules(),
  ]);
  res.json({ types, fuelTypes, registrationRules });
}));

/* ══════════════════════════════════════════════
   THE USER'S GARAGE
   ══════════════════════════════════════════════ */

/**
 * Every read of a user vehicle goes through this projection. It returns the
 * original snake_case columns untouched (so `make`, `model`, `registration_no`
 * keep working for existing callers) and adds the resolved master names.
 */
const VEHICLE_SELECT = `
  SELECT v.*,
         t.name  AS vehicle_type_name,   t.code  AS vehicle_type_code,
         c.name  AS vehicle_category_name, c.code AS vehicle_category_code,
         c.icon  AS vehicle_category_icon, c.is_electric AS category_is_electric,
         mf.name AS manufacturer_name,
         vm.name AS model_name,
         vv.name AS variant_name,
         ft.name AS fuel_type_name, ft.code AS fuel_type_code, ft.is_electric AS fuel_is_electric
    FROM vehicles v
    LEFT JOIN vehicle_types         t  ON t.id  = v.vehicle_type_id
    LEFT JOIN vehicle_categories    c  ON c.id  = v.vehicle_category_id
    LEFT JOIN vehicle_manufacturers mf ON mf.id = v.vehicle_manufacturer_id
    LEFT JOIN vehicle_models        vm ON vm.id = v.vehicle_model_id
    LEFT JOIN vehicle_variants      vv ON vv.id = v.vehicle_variant_id
    LEFT JOIN vehicle_fuel_types    ft ON ft.id = v.vehicle_fuel_type_id`;

function vehicleRow(r: any) {
  if (!r) return r;
  return { ...r, is_electric: bool(r.fuel_is_electric) || bool(r.category_is_electric) };
}

const getVehicle = async (id: number, userId: number) =>
  vehicleRow(await db.prepare(`${VEHICLE_SELECT} WHERE v.id = ? AND v.user_id = ?`).get(id, userId));

/** Thrown by resolveSelection so validation failures become clean 400s. */
class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Turns whatever the client sent into a validated set of master references
 * plus the denormalized `make` / `model` text the rest of the platform reads.
 *
 * Legacy clients that only send `make` / `model` free text still work: they
 * land on the "Other" path instead of being rejected.
 */
async function resolveSelection(body: any) {
  const pick = (v: any) => {
    const n = int(v);
    return n === OTHER_OPTION_ID ? null : n;
  };
  const text = (v: any) => {
    const s = String(v ?? '').trim();
    return s ? s.slice(0, 120) : null;
  };

  const chose = (v: any) => int(v) === OTHER_OPTION_ID;
  const customManufacturer = chose(body.manufacturerId) || body.manufacturerId == null
    ? text(body.customManufacturer) ?? text(body.make)
    : null;
  const customModel = chose(body.modelId) || body.modelId == null
    ? text(body.customModel) ?? text(body.model)
    : null;
  const customVariant = text(body.customVariant);

  let categoryId = pick(body.vehicleCategoryId);
  let typeId = pick(body.vehicleTypeId);
  const manufacturerId = pick(body.manufacturerId);
  const modelId = pick(body.modelId);
  const variantId = pick(body.variantId);
  const fuelTypeId = pick(body.fuelTypeId);

  // ── Category (and, through it, type) ──
  let category: any = null;
  if (categoryId != null) {
    category = await db
      .prepare('SELECT * FROM vehicle_categories WHERE id = ? AND is_active = 1')
      .get(categoryId);
    if (!category)
      throw new ValidationError('That vehicle category is no longer available. Please pick another.');
    typeId = category.vehicle_type_id;
  } else if (typeId != null) {
    const type = await db.prepare('SELECT id FROM vehicle_types WHERE id = ? AND is_active = 1').get(typeId);
    if (!type) throw new ValidationError('That vehicle type is no longer available. Please pick another.');
  }

  // ── Model: must belong to the chosen manufacturer and category ──
  let model: any = null;
  if (modelId != null) {
    model = await db
      .prepare(
        `SELECT vm.*, mf.name AS manufacturer_name
           FROM vehicle_models vm
           JOIN vehicle_manufacturers mf ON mf.id = vm.vehicle_manufacturer_id AND mf.is_active = 1
          WHERE vm.id = ? AND vm.is_active = 1`,
      )
      .get(modelId);
    if (!model) throw new ValidationError('That model is no longer available. Please pick another.');
    if (manufacturerId != null && model.vehicle_manufacturer_id !== manufacturerId)
      throw new ValidationError('That model does not belong to the selected manufacturer.');
    if (categoryId != null && model.vehicle_category_id !== categoryId)
      throw new ValidationError('That model does not belong to the selected category.');
    // A model is enough to settle category and type on its own.
    if (categoryId == null) {
      categoryId = model.vehicle_category_id;
      category = await db.prepare('SELECT * FROM vehicle_categories WHERE id = ?').get(categoryId);
      typeId = category?.vehicle_type_id ?? typeId;
    }
  }

  // ── Manufacturer ──
  let manufacturer: any = null;
  if (manufacturerId != null) {
    manufacturer = await db
      .prepare('SELECT * FROM vehicle_manufacturers WHERE id = ? AND is_active = 1')
      .get(manufacturerId);
    if (!manufacturer)
      throw new ValidationError('That manufacturer is no longer available. Please pick another.');
    if (categoryId != null && model == null) {
      const link = await db
        .prepare(
          `SELECT 1 FROM vehicle_category_manufacturers
            WHERE vehicle_category_id = ? AND vehicle_manufacturer_id = ? AND is_active = 1`,
        )
        .get(categoryId, manufacturerId);
      if (!link)
        throw new ValidationError('That manufacturer does not make vehicles in the selected category.');
    }
  }

  // ── Variant ──
  let variant: any = null;
  if (variantId != null) {
    variant = await db
      .prepare('SELECT * FROM vehicle_variants WHERE id = ? AND is_active = 1')
      .get(variantId);
    if (!variant) throw new ValidationError('That variant is no longer available. Please pick another.');
    if (modelId != null && variant.vehicle_model_id !== modelId)
      throw new ValidationError('That variant does not belong to the selected model.');
  }

  // ── Fuel / power type ──
  let fuelType: any = null;
  if (fuelTypeId != null) {
    fuelType = await db
      .prepare('SELECT * FROM vehicle_fuel_types WHERE id = ? AND is_active = 1')
      .get(fuelTypeId);
    if (!fuelType)
      throw new ValidationError('That fuel / power type is no longer available. Please pick another.');
  }

  // ── What the rest of the platform reads ──
  const make = manufacturer?.name ?? customManufacturer;
  const modelText = model?.name ?? customModel;
  if (!make) throw new ValidationError('Select a manufacturer, or choose "Other" and type one in.');
  if (!modelText) throw new ValidationError('Select a model, or choose "Other" and type one in.');
  if (categoryId == null) throw new ValidationError('Select a vehicle category.');

  return {
    typeId,
    categoryId,
    manufacturerId,
    modelId,
    variantId,
    fuelTypeId,
    customManufacturer: manufacturer ? null : customManufacturer,
    customModel: model ? null : customModel,
    customVariant: variant ? null : customVariant,
    make,
    model: modelText,
  };
}

/** Registration + year checks, using the rule configured for this selection. */
async function validateIdentity(body: any, selection: { typeId: number | null; categoryId: number | null }) {
  const yearError = validateVehicleYear(body.year);
  if (yearError) throw new ValidationError(yearError);

  const rule = resolveRegistrationRule(await loadRules(), {
    vehicleTypeId: selection.typeId,
    vehicleCategoryId: selection.categoryId,
  });
  const registrationNo = normalizeRegistrationNo(body.registrationNo ?? '');
  const regError = validateRegistrationNo(registrationNo, rule);
  if (regError) throw new ValidationError(regError);

  return { year: Number(body.year), registrationNo };
}

// GET /api/vehicles — the user's garage. Archived vehicles are hidden unless
// explicitly asked for, so their service history stays reachable.
vehiclesRouter.get('/vehicles', requireAuth, h(async (req: AuthedRequest, res) => {
  const includeArchived = req.query.includeArchived === '1' || req.query.includeArchived === 'true';
  const rows = await db
    .prepare(
      `${VEHICLE_SELECT}
        WHERE v.user_id = ? AND (?::boolean OR v.is_active = 1)
        ORDER BY v.is_active DESC, v.id DESC`,
    )
    .all(req.auth!.id, includeArchived);
  res.json(rows.map(vehicleRow));
}));

// GET /api/vehicles/:id
vehiclesRouter.get('/vehicles/:id', requireAuth, h(async (req: AuthedRequest, res) => {
  const row = await getVehicle(Number(req.params.id), req.auth!.id);
  if (!row) return res.status(404).json({ error: 'Vehicle not found' });
  res.json(row);
}));

// POST /api/vehicles
vehiclesRouter.post('/vehicles', requireAuth, h(async (req: AuthedRequest, res) => {
  let sel: Awaited<ReturnType<typeof resolveSelection>>;
  let identity: { year: number; registrationNo: string };
  try {
    sel = await resolveSelection(req.body);
    identity = await validateIdentity(req.body, sel);
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    throw err;
  }

  const clash = await db
    .prepare('SELECT id FROM vehicles WHERE registration_no = ?')
    .get(identity.registrationNo);
  if (clash) return res.status(409).json({ error: 'A vehicle with that registration number already exists' });

  const info = await db
    .prepare(
      `INSERT INTO vehicles
         (user_id, make, model, year, registration_no,
          vehicle_type_id, vehicle_category_id, vehicle_manufacturer_id,
          vehicle_model_id, vehicle_variant_id, vehicle_fuel_type_id,
          custom_manufacturer, custom_model, custom_variant, nickname)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      req.auth!.id, sel.make, sel.model, identity.year, identity.registrationNo,
      sel.typeId, sel.categoryId, sel.manufacturerId,
      sel.modelId, sel.variantId, sel.fuelTypeId,
      sel.customManufacturer, sel.customModel, sel.customVariant,
      String(req.body.nickname ?? '').trim() || null,
    );

  logAction('add_vehicle', `user=${req.auth!.id} ${sel.make} ${sel.model}`);
  res.status(201).json(await getVehicle(Number(info.lastInsertRowid), req.auth!.id));
}));

// PUT /api/vehicles/:id
vehiclesRouter.put('/vehicles/:id', requireAuth, h(async (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const current = await getVehicle(id, req.auth!.id);
  if (!current) return res.status(404).json({ error: 'Vehicle not found' });

  // Unspecified fields keep their current value, so a partial edit is safe.
  const merged = {
    vehicleTypeId: req.body.vehicleTypeId ?? current.vehicle_type_id,
    vehicleCategoryId: req.body.vehicleCategoryId ?? current.vehicle_category_id,
    manufacturerId: req.body.manufacturerId ?? current.vehicle_manufacturer_id,
    modelId: req.body.modelId ?? current.vehicle_model_id,
    variantId: req.body.variantId ?? current.vehicle_variant_id,
    fuelTypeId: req.body.fuelTypeId ?? current.vehicle_fuel_type_id,
    customManufacturer: req.body.customManufacturer ?? current.custom_manufacturer,
    customModel: req.body.customModel ?? current.custom_model,
    customVariant: req.body.customVariant ?? current.custom_variant,
    year: req.body.year ?? current.year,
    registrationNo: req.body.registrationNo ?? current.registration_no,
  };

  let sel: Awaited<ReturnType<typeof resolveSelection>>;
  let identity: { year: number; registrationNo: string };
  try {
    sel = await resolveSelection(merged);
    identity = await validateIdentity(merged, sel);
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    throw err;
  }

  const clash = await db
    .prepare('SELECT id FROM vehicles WHERE registration_no = ? AND id <> ?')
    .get(identity.registrationNo, id);
  if (clash) return res.status(409).json({ error: 'A vehicle with that registration number already exists' });

  await db
    .prepare(
      `UPDATE vehicles SET
         make = ?, model = ?, year = ?, registration_no = ?,
         vehicle_type_id = ?, vehicle_category_id = ?, vehicle_manufacturer_id = ?,
         vehicle_model_id = ?, vehicle_variant_id = ?, vehicle_fuel_type_id = ?,
         custom_manufacturer = ?, custom_model = ?, custom_variant = ?,
         nickname = COALESCE(?, nickname), updated_at = now()
       WHERE id = ? AND user_id = ?`,
    )
    .run(
      sel.make, sel.model, identity.year, identity.registrationNo,
      sel.typeId, sel.categoryId, sel.manufacturerId,
      sel.modelId, sel.variantId, sel.fuelTypeId,
      sel.customManufacturer, sel.customModel, sel.customVariant,
      req.body.nickname === undefined ? null : String(req.body.nickname ?? '').trim() || null,
      id, req.auth!.id,
    );

  logAction('update_vehicle', `user=${req.auth!.id} vehicle=${id}`);
  res.json(await getVehicle(id, req.auth!.id));
}));

// DELETE /api/vehicles/:id
//
// service_requests.vehicle_id cascades on delete, so a vehicle that has ever
// been serviced is ARCHIVED instead of removed: the user stops seeing it, and
// their bookings, payments and ratings are all still there.
vehiclesRouter.delete('/vehicles/:id', requireAuth, h(async (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const current = await getVehicle(id, req.auth!.id);
  if (!current) return res.status(404).json({ error: 'Vehicle not found' });

  const used: any = await db
    .prepare(
      `SELECT (SELECT COUNT(*)::int FROM service_requests WHERE vehicle_id = ?) AS services,
              (SELECT COUNT(*)::int FROM nearby_requests  WHERE vehicle_id = ?) AS roadside`,
    )
    .get(id, id);

  if ((used?.services ?? 0) + (used?.roadside ?? 0) > 0) {
    await db.prepare('UPDATE vehicles SET is_active = 0, updated_at = now() WHERE id = ? AND user_id = ?')
      .run(id, req.auth!.id);
    logAction('archive_vehicle', `user=${req.auth!.id} vehicle=${id} services=${used.services}`);
    return res.json({
      ok: true,
      id,
      archived: true,
      message: 'Vehicle removed from your garage. Its service history has been kept.',
    });
  }

  await db.prepare('DELETE FROM vehicles WHERE id = ? AND user_id = ?').run(id, req.auth!.id);
  logAction('delete_vehicle', `user=${req.auth!.id} vehicle=${id}`);
  res.json({ ok: true, id, archived: false, message: 'Vehicle removed from your garage.' });
}));
