-- =====================================================================
-- FixMyRide — Job completion, payment & rating (roadside assistance)
-- Target database : am_mech
--
-- The mechanic module needs three things the user module owns:
--   * the final amount it charged,
--   * how the customer settled up (so it can chase cash), and
--   * the customer's rating.
--
-- Ratings land in the EXISTING `reviews` table rather than a new one, so the
-- Reviews screen, the /feedback summary and the mechanic's headline rating
-- all pick them up with no extra wiring. A nullable nearby_request_id ties a
-- review back to the roadside job it came from.
--
-- Additive and idempotent.
--   psql -U postgres -h localhost -d am_mech -f docs/am_mech_nearby_payment_rating.sql
-- =====================================================================

BEGIN;

-- ── nearby_requests mirror: completion + payment outcome ──────────────
ALTER TABLE nearby_requests ADD COLUMN IF NOT EXISTS final_amount   NUMERIC(10,2);
ALTER TABLE nearby_requests ADD COLUMN IF NOT EXISTS completed_at   TIMESTAMPTZ;
ALTER TABLE nearby_requests ADD COLUMN IF NOT EXISTS payment_method TEXT
       CHECK (payment_method IN ('ONLINE','CASH'));
ALTER TABLE nearby_requests ADD COLUMN IF NOT EXISTS payment_status TEXT
       CHECK (payment_status IN ('PENDING','PAID','CASH_SELECTED','FAILED'));
ALTER TABLE nearby_requests ADD COLUMN IF NOT EXISTS customer_rating INTEGER
       CHECK (customer_rating BETWEEN 1 AND 5);

ALTER TABLE nearby_requests DROP CONSTRAINT IF EXISTS nearby_requests_status_check;
ALTER TABLE nearby_requests ADD  CONSTRAINT nearby_requests_status_check
  CHECK (status IN ('SEARCHING','PENDING_MECHANIC_RESPONSE','ACCEPTED','REJECTED',
                    'MECHANIC_ON_THE_WAY','ARRIVED','IN_SERVICE','COMPLETED',
                    'PAYMENT_PENDING','PAYMENT_COMPLETED','CASH_SELECTED','RATED',
                    'CANCELLED','NO_MECHANIC_FOUND'));

-- ── reviews: trace a review back to its roadside job ──────────────────
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS nearby_request_id INTEGER;

-- Partial unique index: one review per roadside job, while leaving the
-- existing service-request reviews (NULL here) completely untouched.
CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_nearby_request
    ON reviews(nearby_request_id)
    WHERE nearby_request_id IS NOT NULL;

COMMIT;
