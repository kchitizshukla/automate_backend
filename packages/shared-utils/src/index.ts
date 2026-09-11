// ──────────────────────────────────────────────
// Framework-agnostic utility helpers shared across apps
// ──────────────────────────────────────────────

export function formatCurrency(amount: number, currency = 'INR'): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(amount);
}

export function formatDate(value: string | Date | null | undefined): string {
  if (value == null) return '—';
  const d = typeof value === 'string' ? new Date(value) : value;
  return d.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (value == null) return '—';
  const d = typeof value === 'string' ? new Date(value) : value;
  return d.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  assigned: 'Assigned',
  accepted: 'Accepted',
  in_progress: 'In Progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
  paid: 'Paid',
  failed: 'Failed',
  refunded: 'Refunded',
  open: 'Open',
  investigating: 'Investigating',
  resolved: 'Resolved',
  closed: 'Closed',
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

export function statusColor(status: string): string {
  switch (status) {
    case 'completed':
    case 'paid':
    case 'resolved':
      return 'green';
    case 'in_progress':
    case 'accepted':
    case 'investigating':
      return 'blue';
    case 'pending':
    case 'assigned':
    case 'open':
      return 'amber';
    case 'cancelled':
    case 'failed':
      return 'red';
    default:
      return 'gray';
  }
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function classNames(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

// Roadside assistance: issue catalogue, pricing engine, distance/ETA helpers.
export * from './nearby';

// Sign-up password rules, shared by all six apps.
export * from './password';

// Vehicle master data: registration rules, labels and validation.
export * from './vehicles';
