// ──────────────────────────────────────────────
// Sign-up password rules.
//
// One definition for all six apps, so User/Mechanic/Admin on web and mobile
// enforce exactly the same thing and show exactly the same wording.
// ──────────────────────────────────────────────

export const PASSWORD_RULES = {
  /** Matches what the seeded accounts use ("password123"), so nothing existing breaks. */
  minLength: 6,
  maxLength: 128,
} as const;

export interface PasswordCheck {
  /** Safe to submit: both fields filled, rules met and the two values equal. */
  valid: boolean;
  /** The single message to show. null when there is nothing to complain about. */
  error: string | null;
  /** True once both fields have content — drives the submit button's enabled state. */
  bothFilled: boolean;
  /** True when the two entries differ. Kept separate so a field can be highlighted. */
  mismatch: boolean;
}

/**
 * Validates the create/confirm pair.
 *
 * Deliberately does NOT trim the password itself — a leading or trailing space
 * is a legitimate part of a password and silently removing it would change
 * what the user typed. Whitespace-only input is still rejected as empty.
 */
export function validatePasswordPair(password: string, confirm: string): PasswordCheck {
  const hasPassword = password.length > 0 && password.trim().length > 0;
  const hasConfirm = confirm.length > 0 && confirm.trim().length > 0;
  const bothFilled = hasPassword && hasConfirm;

  if (!bothFilled) {
    return {
      valid: false,
      error: null, // nothing typed yet is not an error worth shouting about
      bothFilled: false,
      mismatch: false,
    };
  }

  if (password.length < PASSWORD_RULES.minLength) {
    return {
      valid: false,
      error: `Password must be at least ${PASSWORD_RULES.minLength} characters.`,
      bothFilled,
      mismatch: false,
    };
  }

  if (password.length > PASSWORD_RULES.maxLength) {
    return {
      valid: false,
      error: `Password must be ${PASSWORD_RULES.maxLength} characters or fewer.`,
      bothFilled,
      mismatch: false,
    };
  }

  if (password !== confirm) {
    return {
      valid: false,
      error: 'Passwords do not match.',
      bothFilled,
      mismatch: true,
    };
  }

  return { valid: true, error: null, bothFilled, mismatch: false };
}
