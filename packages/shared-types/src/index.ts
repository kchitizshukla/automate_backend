// ──────────────────────────────────────────────
// Shared domain types used across all AutoMate apps
// ──────────────────────────────────────────────

export type Role = 'user' | 'mechanic' | 'admin';

export type ServiceStatus =
  | 'pending'
  | 'assigned'
  | 'accepted'
  | 'in_progress'
  | 'completed'
  | 'cancelled';

export type PaymentStatus = 'pending' | 'paid' | 'failed' | 'refunded';

export type IssueStatus = 'open' | 'investigating' | 'resolved' | 'closed';

export type JobUpdateType = 'note' | 'status_change' | 'image';

export interface AuthUser {
  id: number;
  name: string;
  email: string;
  role: Role;
}

export interface AuthResponse {
  token: string;
  user: AuthUser;
}

/**
 * A vehicle in the user's garage.
 *
 * `make` / `model` stay as denormalized display text so every existing consumer
 * (service requests, the roadside snapshot, the mechanic and admin modules)
 * keeps working untouched. The `*Id` fields are the authoritative references
 * into the vehicle master tables and are populated for anything added or
 * migrated since multi-vehicle support landed.
 */
export interface Vehicle {
  id: number;
  userId: number;
  make: string;
  model: string;
  year: number;
  registrationNo: string;
  createdAt: string;

  // ── Master-data references (optional: legacy rows may predate them) ──
  vehicleTypeId?: number | null;
  vehicleTypeName?: string | null;
  vehicleTypeCode?: string | null;
  vehicleCategoryId?: number | null;
  vehicleCategoryName?: string | null;
  vehicleCategoryCode?: string | null;
  vehicleCategoryIcon?: string | null;
  manufacturerId?: number | null;
  manufacturerName?: string | null;
  modelId?: number | null;
  modelName?: string | null;
  variantId?: number | null;
  variantName?: string | null;
  fuelTypeId?: number | null;
  fuelTypeName?: string | null;
  fuelTypeCode?: string | null;
  isElectric?: boolean;

  /** Free text captured when the user chose "Other" instead of a master row. */
  customManufacturer?: string | null;
  customModel?: string | null;
  customVariant?: string | null;
  /** Optional user-given name, e.g. "Dad's tractor". */
  nickname?: string | null;
  /** 0 once archived. Archived vehicles keep their service history readable. */
  isActive?: boolean;
  updatedAt?: string | null;
}

export interface ServiceRequest {
  id: number;
  userId: number;
  vehicleId: number;
  mechanicId: number | null;
  category: string;
  description: string;
  status: ServiceStatus;
  scheduledAt: string | null;
  price: number | null;
  bookingRef?: string | null;
  estimatedDuration?: string | null;
  rated?: number;
  createdAt: string;
  updatedAt: string;
}

export interface Payment {
  id: number;
  serviceRequestId: number;
  userId: number;
  amount: number;
  method: string;
  status: PaymentStatus;
  transactionRef: string;
  createdAt: string;
}

export interface Issue {
  id: number;
  userId: number;
  serviceRequestId: number | null;
  title: string;
  description: string;
  imagePath: string | null;
  status: IssueStatus;
  createdAt: string;
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface Mechanic {
  id: number;
  name: string;
  email: string;
  phone: string;
  skills: string;
  available: boolean;
  rating: number;
  createdAt: string;
  // Vendor onboarding / discovery fields (per AutoRevive flow)
  workshopName?: string;
  location?: string;
  specialization?: string;
  priceFrom?: number;
  reviewsCount?: number;
  approvalStatus?: ApprovalStatus;
}

// A vendor profile as surfaced to clients during Service Discovery.
export interface MechanicProfile extends Mechanic {
  reviews?: Review[];
}

export interface Review {
  id: number;
  serviceRequestId: number;
  mechanicId: number;
  userId: number;
  userName?: string;
  rating: number; // 1..5
  comment: string | null;
  createdAt: string;
}

export interface Earnings {
  totalEarned: number;
  pendingPayout: number;
  completedJobs: number;
  averageRating: number;
  monthly: { month: string; amount: number }[];
}

export interface Job {
  id: number;
  serviceRequestId: number;
  mechanicId: number;
  status: ServiceStatus;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface JobUpdate {
  id: number;
  jobId: number;
  type: JobUpdateType;
  message: string | null;
  imagePath: string | null;
  createdAt: string;
}

export interface SystemLog {
  id: number;
  actorRole: Role;
  actorId: number | null;
  action: string;
  detail: string | null;
  createdAt: string;
}

export interface Notification {
  id: number;
  recipientRole: Role;
  recipientId: number;
  title: string;
  body: string;
  read: boolean;
  createdAt: string;
}

export interface ApiError {
  error: string;
  details?: unknown;
}

// Vehicle master data (types, categories, manufacturers, models, variants).
export * from './vehicles';

// Roadside assistance domain ('Find Mechanics Nearby').
export * from './nearby';
