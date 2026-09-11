// ──────────────────────────────────────────────
// Vehicle master data — the taxonomy every AutoMate frontend selects from.
//
// None of this is hardcoded in a component: the shapes below describe rows the
// user backend serves from the VEHICLE_* master tables. Adding a vehicle type,
// manufacturer, model or variant is a database change, never a deploy.
//
//   VehicleType → VehicleCategory → VehicleManufacturer → VehicleModel
//                                        → VehicleVariant → VehicleFuelType
// ──────────────────────────────────────────────

/** Fields every master row carries. The API only ever returns active rows. */
export interface MasterRecord {
  id: number;
  name: string;
  /** Stable machine key (`two_wheeler`, `motorcycle`, `electric`). */
  code: string;
  description?: string | null;
  /** Emoji or icon key chosen by the master data, not by the frontend. */
  icon?: string | null;
  displayOrder: number;
  isActive: boolean;
  createdAt?: string;
  updatedAt?: string;
}

/** Top of the hierarchy — Two Wheeler, Four Wheeler, Three Wheeler… */
export interface VehicleType extends MasterRecord {
  /** How many categories hang off this type. Lets the UI hide empty branches. */
  categoryCount?: number;
}

/** Motorcycle, Scooter, Car, Truck, Tractor, Ambulance… */
export interface VehicleCategory extends MasterRecord {
  vehicleTypeId: number;
  vehicleTypeName?: string;
  vehicleTypeCode?: string;
  /** True for categories whose vehicles are electric by definition (E-Rickshaw). */
  isElectric?: boolean;
}

/** Honda, Tata, Royal Enfield… A manufacturer may serve many categories. */
export interface VehicleManufacturer extends MasterRecord {
  logoUrl?: string | null;
  /** Present when the row was fetched through a category filter. */
  vehicleCategoryId?: number;
}

export interface VehicleModel extends MasterRecord {
  manufacturerId: number;
  manufacturerName?: string;
  vehicleCategoryId: number;
  vehicleCategoryName?: string;
}

export interface VehicleVariant extends MasterRecord {
  vehicleModelId: number;
  vehicleModelName?: string;
}

/** Petrol, Diesel, Electric, Hybrid, Hydrogen… */
export interface VehicleFuelType extends MasterRecord {
  /** True for Electric / Plug-in Hybrid — EVs are first-class, not a car flavour. */
  isElectric: boolean;
}

/**
 * Registration-number rule for a vehicle type or category. Served by the API so
 * a tractor or a construction vehicle is never forced through a car's format.
 */
export interface RegistrationRule {
  id: number;
  vehicleTypeId: number | null;
  vehicleCategoryId: number | null;
  /** JavaScript-compatible regex source, matched case-insensitively. */
  pattern: string | null;
  /** Shown in the input while empty, e.g. "MH12AB1234". */
  placeholder: string | null;
  helpText: string | null;
  minLength: number;
  maxLength: number;
  isRequired: boolean;
}

/** Everything the add/edit form needs before the user touches a control. */
export interface VehicleMasterBootstrap {
  types: VehicleType[];
  fuelTypes: VehicleFuelType[];
  registrationRules: RegistrationRule[];
}

/** One page of a searchable master list (manufacturers, models). */
export interface MasterPage<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

/**
 * Payload for creating/updating a user vehicle. Everything except the
 * registration number is a reference into master data; the `custom*` fields
 * only carry text when the user picked the "Other" escape hatch.
 */
export interface VehicleInput {
  vehicleTypeId?: number | null;
  vehicleCategoryId?: number | null;
  manufacturerId?: number | null;
  modelId?: number | null;
  variantId?: number | null;
  fuelTypeId?: number | null;
  customManufacturer?: string | null;
  customModel?: string | null;
  customVariant?: string | null;
  nickname?: string | null;
  year: number;
  registrationNo: string;
  /** Legacy free-text fallback, still accepted so older clients keep working. */
  make?: string;
  model?: string;
}
