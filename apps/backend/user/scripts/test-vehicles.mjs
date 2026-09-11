/**
 * End-to-end check for the dynamic multi-vehicle API.
 *
 * The repo has no test runner, so this is a dependency-free script that talks
 * to a running user backend the same way the web and mobile apps do. It walks
 * the master hierarchy, adds one vehicle of every requested kind, edits and
 * deletes them, exercises the error paths, and asserts that pre-existing
 * users, vehicles and service requests are untouched.
 *
 * Run (with the backend up on :4001):
 *   npm run test:vehicles --workspace apps/backend/user
 */
const BASE = process.env.USER_API || 'http://localhost:4001/api';
const EMAIL = process.env.TEST_EMAIL || 'aarav@example.com';
const PASSWORD = process.env.TEST_PASSWORD || 'password123';

let token = '';
let passed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function call(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

const get = (p) => call(p);
const post = (p, data) => call(p, { method: 'POST', body: JSON.stringify(data) });
const put = (p, data) => call(p, { method: 'PUT', body: JSON.stringify(data) });
const del = (p) => call(p, { method: 'DELETE' });

/** A registration number that will not collide with the seed data. */
let plateSeq = 0;
const plate = () => `TS${String(10 + (plateSeq % 89)).padStart(2, '0')}ZZ${String(1000 + plateSeq++).slice(0, 4)}`;

/** Walks the full chain for a category code and adds a vehicle. Returns its id. */
async function addVehicleOfCategory(categoryCode, { fuelCode } = {}) {
  const types = (await get('/vehicles/types')).body;
  let category = null;
  let type = null;
  for (const t of types) {
    const cats = (await get(`/vehicles/categories?typeId=${t.id}`)).body;
    const hit = cats.find((c) => c.code === categoryCode);
    if (hit) {
      category = hit;
      type = t;
      break;
    }
  }
  if (!category) throw new Error(`No category "${categoryCode}" in master data`);

  const mfrs = (await get(`/vehicles/manufacturers?categoryId=${category.id}`)).body;
  const manufacturer = mfrs.items.find((m) => m.id > 0);
  if (!manufacturer) throw new Error(`No manufacturer for category "${categoryCode}"`);

  const models = (await get(`/vehicles/models?manufacturerId=${manufacturer.id}&categoryId=${category.id}`)).body;
  const model = models.items.find((m) => m.id > 0);
  if (!model) throw new Error(`No model for ${manufacturer.name} / ${categoryCode}`);

  const variants = (await get(`/vehicles/variants?modelId=${model.id}`)).body;
  const variant = variants.items.find((v) => v.id > 0) ?? null;

  const fuels = (await get(`/vehicles/fuel-types?modelId=${model.id}&categoryId=${category.id}`)).body;
  const fuel = fuelCode ? fuels.find((f) => f.code === fuelCode) : fuels[0];

  const res = await post('/vehicles', {
    vehicleTypeId: type.id,
    vehicleCategoryId: category.id,
    manufacturerId: manufacturer.id,
    modelId: model.id,
    variantId: variant?.id ?? null,
    fuelTypeId: fuel?.id ?? null,
    year: 2022,
    registrationNo: plate(),
  });
  return { res, category, manufacturer, model, variant, fuel, type };
}

async function main() {
  console.log(`\nAutoMate — multi-vehicle API checks against ${BASE}\n`);

  // ── Auth ──────────────────────────────────────
  console.log('Auth');
  const login = await post('/auth/login', { email: EMAIL, password: PASSWORD });
  check('login succeeds', login.status === 200, `status ${login.status}`);
  token = login.body?.token ?? '';
  if (!token) {
    console.error('\nCannot continue without a token.');
    process.exit(1);
  }

  // ── Baseline: existing data must survive everything below ──
  const baselineVehicles = (await get('/vehicles')).body;
  const baselineServices = (await get('/services')).body;
  check('existing user can still see their vehicles', Array.isArray(baselineVehicles) && baselineVehicles.length > 0,
    `got ${baselineVehicles?.length}`);
  check('existing service requests still load', Array.isArray(baselineServices));
  check('migrated vehicle carries master data',
    baselineVehicles.every((v) => v.vehicle_category_id != null && v.vehicle_type_id != null));
  check('migrated vehicle keeps its legacy make/model text',
    baselineVehicles.every((v) => !!v.make && !!v.model && !!v.registration_no));

  // ── Master data ───────────────────────────────
  console.log('\nMaster data');
  const types = (await get('/vehicles/types')).body;
  check('types are returned', Array.isArray(types) && types.length >= 8, `got ${types?.length}`);
  check('types are ordered by display_order',
    types.every((t, i) => i === 0 || types[i - 1].displayOrder <= t.displayOrder));
  check('every type is active', types.every((t) => t.isActive));

  const allCats = (await get('/vehicles/categories')).body;
  check('categories are returned unfiltered', allCats.length >= 25, `got ${allCats.length}`);
  const requiredCategories = [
    'car', 'suv', 'motorcycle', 'scooter', 'electric_bike', 'electric_scooter',
    'auto_rickshaw', 'electric_3w', 'pickup', 'truck', 'mini_truck', 'bus',
    'school_bus', 'van', 'tempo', 'tractor', 'tractor_trailer', 'agri_vehicle',
    'construction', 'earthmoving', 'ambulance', 'fire_truck', 'taxi',
    'electric_car', 'electric_lcv', 'electric_bus', 'other_category',
  ];
  const missing = requiredCategories.filter((c) => !allCats.some((x) => x.code === c));
  check('every requested vehicle category exists', missing.length === 0, `missing ${missing.join(', ')}`);
  check('categories carry an icon from master data', allCats.every((c) => !!c.icon));

  const catsForType = (await get(`/vehicles/categories?typeId=${types[0].id}`)).body;
  check('categories filter by type', catsForType.every((c) => c.vehicleTypeId === types[0].id));

  const fuels = (await get('/vehicles/fuel-types')).body;
  check('fuel types include the full power range',
    ['petrol', 'diesel', 'cng', 'lpg', 'electric', 'hybrid', 'phev', 'hydrogen'].every((c) =>
      fuels.some((f) => f.code === c)));
  check('electric is flagged as electric', fuels.find((f) => f.code === 'electric')?.isElectric === true);

  const bootstrap = (await get('/vehicles/master')).body;
  check('bootstrap returns types, fuel types and registration rules',
    bootstrap.types?.length > 0 && bootstrap.fuelTypes?.length > 0 && bootstrap.registrationRules?.length > 0);

  // Dependent filtering
  const scooterCat = allCats.find((c) => c.code === 'scooter');
  const scooterMfrs = (await get(`/vehicles/manufacturers?categoryId=${scooterCat.id}`)).body;
  check('manufacturers are scoped to the category', scooterMfrs.items.some((m) => m.name === 'Honda'));
  check('"Other" escape hatch is offered', scooterMfrs.items.some((m) => m.id === -1));

  const honda = scooterMfrs.items.find((m) => m.name === 'Honda');
  const hondaScooters = (await get(`/vehicles/models?manufacturerId=${honda.id}&categoryId=${scooterCat.id}`)).body;
  check('models are scoped to manufacturer + category',
    hondaScooters.items.filter((m) => m.id > 0).every((m) => m.manufacturerId === honda.id));
  check('Honda Activa is reachable through the chain',
    hondaScooters.items.some((m) => m.name.startsWith('Activa')));

  const carCat = allCats.find((c) => c.code === 'car');
  const hondaCars = (await get(`/vehicles/models?manufacturerId=${honda.id}&categoryId=${carCat.id}`)).body;
  check('the same brand yields different models per category',
    hondaCars.items.some((m) => m.name === 'City') && !hondaScooters.items.some((m) => m.name === 'City'));

  // Search + pagination
  const search = (await get('/vehicles/models?q=swift')).body;
  check('model search finds Swift', search.items.some((m) => m.name === 'Swift'));
  const paged = (await get('/vehicles/models?pageSize=5&page=1')).body;
  check('models paginate', paged.items.filter((m) => m.id > 0).length === 5 && paged.hasMore === true,
    `items=${paged.items.length} hasMore=${paged.hasMore}`);
  const emptySearch = (await get('/vehicles/models?q=zzzzznotathing')).body;
  check('an empty search returns an empty page, not an error',
    Array.isArray(emptySearch.items) && emptySearch.total === 0);

  // EV narrowing
  const evCat = allCats.find((c) => c.code === 'electric_car');
  const evMfrs = (await get(`/vehicles/manufacturers?categoryId=${evCat.id}`)).body;
  const evModels = (await get(`/vehicles/models?categoryId=${evCat.id}`)).body;
  const evModel = evModels.items.find((m) => m.id > 0);
  const evFuels = (await get(`/vehicles/fuel-types?modelId=${evModel.id}&categoryId=${evCat.id}`)).body;
  check('EV manufacturers are available', evMfrs.items.some((m) => m.id > 0));
  check('an electric category only offers electric power types',
    evFuels.length > 0 && evFuels.every((f) => f.isElectric));

  // ── Add one vehicle of every kind ─────────────
  console.log('\nAdd vehicle — every supported kind');
  const created = [];
  const kinds = [
    ['car', 'Add car'],
    ['motorcycle', 'Add bike'],
    ['scooter', 'Add scooter'],
    ['truck', 'Add truck'],
    ['tractor', 'Add tractor'],
    ['bus', 'Add bus'],
    ['school_bus', 'Add school bus'],
    ['van', 'Add van'],
    ['auto_rickshaw', 'Add three-wheeler'],
    ['electric_car', 'Add electric car'],
    ['electric_scooter', 'Add electric scooter'],
    ['electric_3w', 'Add electric three-wheeler'],
    ['electric_bus', 'Add electric bus'],
    ['pickup', 'Add pickup truck'],
    ['mini_truck', 'Add mini truck'],
    ['tempo', 'Add tempo / mini van'],
    ['tractor_trailer', 'Add tractor with trailer'],
    ['agri_vehicle', 'Add agricultural vehicle'],
    ['construction', 'Add construction vehicle'],
    ['earthmoving', 'Add earthmoving vehicle'],
    ['ambulance', 'Add ambulance'],
    ['fire_truck', 'Add fire truck'],
    ['taxi', 'Add taxi / commercial car'],
    ['electric_lcv', 'Add electric commercial vehicle'],
  ];
  for (const [code, label] of kinds) {
    try {
      const { res, category } = await addVehicleOfCategory(code);
      check(label, res.status === 201, `status ${res.status} ${JSON.stringify(res.body)}`);
      if (res.status === 201) {
        created.push(res.body.id);
        check(`  ${label} resolves its category`, res.body.vehicle_category_name === category.name);
      }
    } catch (err) {
      check(label, false, err.message);
    }
  }

  // ── "Other" escape hatch ──────────────────────
  console.log('\n"Other" vehicle support');
  const otherCat = allCats.find((c) => c.code === 'other_category');
  const otherRes = await post('/vehicles', {
    vehicleCategoryId: otherCat.id,
    manufacturerId: -1,
    modelId: -1,
    customManufacturer: 'Hypothetical Motors',
    customModel: 'Snow Groomer 9000',
    year: 2024,
    registrationNo: plate(),
  });
  check('a vehicle not in master data can still be added', otherRes.status === 201,
    `status ${otherRes.status} ${JSON.stringify(otherRes.body)}`);
  if (otherRes.status === 201) {
    created.push(otherRes.body.id);
    check('"Other" text is preserved as make/model',
      otherRes.body.make === 'Hypothetical Motors' && otherRes.body.model === 'Snow Groomer 9000');
    check('"Other" text is kept in the custom columns',
      otherRes.body.custom_manufacturer === 'Hypothetical Motors');
  }

  // ── Validation ────────────────────────────────
  console.log('\nValidation');
  const noCategory = await post('/vehicles', { year: 2020, registrationNo: plate() });
  check('a vehicle without a category is rejected', noCategory.status === 400);

  const badYear = await post('/vehicles', {
    vehicleCategoryId: carCat.id, manufacturerId: honda.id,
    modelId: hondaCars.items.find((m) => m.id > 0).id, year: 1800, registrationNo: plate(),
  });
  check('an impossible year is rejected', badYear.status === 400, JSON.stringify(badYear.body));

  const badPlate = await post('/vehicles', {
    vehicleCategoryId: carCat.id, manufacturerId: honda.id,
    modelId: hondaCars.items.find((m) => m.id > 0).id, year: 2020, registrationNo: 'X',
  });
  check('a malformed registration number is rejected', badPlate.status === 400, JSON.stringify(badPlate.body));

  const tractorCat = allCats.find((c) => c.code === 'tractor');
  const tractorMfrs = (await get(`/vehicles/manufacturers?categoryId=${tractorCat.id}`)).body;
  const tractorMfr = tractorMfrs.items.find((m) => m.id > 0);
  const tractorModels = (await get(`/vehicles/models?manufacturerId=${tractorMfr.id}&categoryId=${tractorCat.id}`)).body;
  const chassisPlate = 'CHASSIS-99881';
  const tractorChassis = await post('/vehicles', {
    vehicleCategoryId: tractorCat.id,
    manufacturerId: tractorMfr.id,
    modelId: tractorModels.items.find((m) => m.id > 0).id,
    year: 2019,
    registrationNo: chassisPlate,
  });
  check('a tractor may use a chassis number (no car format imposed)', tractorChassis.status === 201,
    `status ${tractorChassis.status} ${JSON.stringify(tractorChassis.body)}`);
  if (tractorChassis.status === 201) created.push(tractorChassis.body.id);

  const crossCategory = await post('/vehicles', {
    vehicleCategoryId: carCat.id,
    manufacturerId: honda.id,
    modelId: hondaScooters.items.find((m) => m.id > 0).id, // a scooter model under Car
    year: 2020,
    registrationNo: plate(),
  });
  check('a model from the wrong category is rejected', crossCategory.status === 400, JSON.stringify(crossCategory.body));

  const inactiveId = await post('/vehicles', {
    vehicleCategoryId: 999999, year: 2020, registrationNo: plate(),
  });
  check('an unknown master id is rejected with a readable message',
    inactiveId.status === 400 && typeof inactiveId.body.error === 'string', JSON.stringify(inactiveId.body));

  const dupe = await post('/vehicles', {
    vehicleCategoryId: carCat.id,
    manufacturerId: honda.id,
    modelId: hondaCars.items.find((m) => m.id > 0).id,
    year: 2020,
    registrationNo: baselineVehicles[0].registration_no,
  });
  check('a duplicate registration number is rejected with 409', dupe.status === 409, JSON.stringify(dupe.body));

  // Legacy client shape must keep working.
  const legacy = await post('/vehicles', {
    make: 'Legacy Motors', model: 'Old Client', year: 2015, registrationNo: plate(),
    vehicleCategoryId: carCat.id,
  });
  check('a legacy make/model payload is still accepted', legacy.status === 201, JSON.stringify(legacy.body));
  if (legacy.status === 201) created.push(legacy.body.id);

  // ── Edit ──────────────────────────────────────
  console.log('\nEdit vehicle');
  const editTarget = created[0];
  const newPlate = plate();
  const edited = await put(`/vehicles/${editTarget}`, { year: 2023, registrationNo: newPlate, nickname: 'Daily driver' });
  check('edit vehicle succeeds', edited.status === 200, JSON.stringify(edited.body));
  check('edit persists the change', edited.body?.year === 2023 && edited.body?.registration_no === newPlate);
  check('edit keeps the untouched master references', edited.body?.vehicle_category_id != null);

  const editToScooter = await put(`/vehicles/${editTarget}`, {
    vehicleCategoryId: scooterCat.id, manufacturerId: honda.id,
    modelId: hondaScooters.items.find((m) => m.id > 0).id, variantId: null,
  });
  check('a car can be re-classified as a scooter', editToScooter.status === 200,
    JSON.stringify(editToScooter.body));
  check('re-classification updates the denormalized make/model',
    editToScooter.body?.model?.startsWith('Activa'), editToScooter.body?.model);

  const editMissing = await put('/vehicles/99999999', { year: 2020 });
  check('editing someone else’s / a missing vehicle 404s', editMissing.status === 404);

  // ── Service request on a non-car ───────────────
  console.log('\nService request with a non-car vehicle');
  const bikeId = created[1];
  const booked = await post('/services', {
    vehicleId: bikeId, category: 'General Service', description: 'Chain and brakes need attention',
  });
  check('a service can be booked against a motorcycle', booked.status === 201, JSON.stringify(booked.body));
  const servicesAfter = (await get('/services')).body;
  check('the booking shows the vehicle category, not a car assumption',
    servicesAfter.some((s) => s.id === booked.body?.id && !!s.vehicle_category_name));

  // ── Delete / archive ──────────────────────────
  console.log('\nDelete vehicle');
  const withHistory = await del(`/vehicles/${bikeId}`);
  check('deleting a vehicle with history archives it', withHistory.status === 200 && withHistory.body.archived === true,
    JSON.stringify(withHistory.body));
  const afterArchive = (await get('/vehicles')).body;
  check('an archived vehicle leaves the garage', !afterArchive.some((v) => v.id === bikeId));
  const servicesStillThere = (await get('/services')).body;
  check('archiving does NOT delete the service request',
    servicesStillThere.some((s) => s.id === booked.body?.id));
  const withArchived = (await get('/vehicles?includeArchived=1')).body;
  check('archived vehicles are still retrievable on request',
    withArchived.some((v) => v.id === bikeId));

  const cleanDelete = await del(`/vehicles/${created[2]}`);
  check('deleting a vehicle with no history removes it',
    cleanDelete.status === 200 && cleanDelete.body.archived === false, JSON.stringify(cleanDelete.body));
  const deleteMissing = await del('/vehicles/99999999');
  check('deleting a missing vehicle 404s', deleteMissing.status === 404);

  // ── Auth / error handling ─────────────────────
  console.log('\nError handling');
  const saved = token;
  token = '';
  const unauth = await get('/vehicles/types');
  check('master data requires authentication', unauth.status === 401);
  token = 'not-a-real-token';
  const badToken = await get('/vehicles/types');
  check('an invalid token is rejected', badToken.status === 401);
  token = saved;

  const badVariant = (await get('/vehicles/variants?modelId=99999999')).body;
  check('variants for an unknown model return an empty list, not an error',
    Array.isArray(badVariant.items));
  const noModelFuels = (await get('/vehicles/fuel-types?modelId=99999999')).body;
  check('fuel types fall back to the full list for an unknown model', noModelFuels.length > 0);

  // ── Cleanup ───────────────────────────────────
  console.log('\nCleanup');
  let removed = 0;
  for (const id of [...created, tractorChassis.body?.id, otherRes.body?.id].filter(Boolean)) {
    const r = await del(`/vehicles/${id}`);
    if (r.status === 200) removed += 1;
  }
  check('test vehicles cleaned up', removed > 0, `${removed} removed`);

  // ── Baseline intact ───────────────────────────
  console.log('\nBackward compatibility');
  const finalVehicles = (await get('/vehicles?includeArchived=1')).body;
  const baselineIds = baselineVehicles.map((v) => v.id);
  check('every pre-existing vehicle still exists',
    baselineIds.every((id) => finalVehicles.some((v) => v.id === id)));
  check('every pre-existing service request still exists',
    baselineServices.every((s) => servicesStillThere.some((x) => x.id === s.id)));
  const payments = await get('/payments');
  check('payments still load', payments.status === 200);
  const mechanics = await get('/mechanics');
  check('mechanic discovery still loads', mechanics.status === 200);

  // ── Report ────────────────────────────────────
  console.log(`\n${'─'.repeat(56)}`);
  console.log(`${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log(`  • ${f}`));
    process.exit(1);
  }
  console.log('All checks passed.\n');
}

main().catch((err) => {
  console.error('\nTest run crashed:', err);
  process.exit(1);
});
