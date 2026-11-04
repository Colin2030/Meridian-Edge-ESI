-- Meridian Edge — global "can create cases" capability.
-- Case creation is a global action (there is no case to scope a per-case role
-- against), so permission is granted via a per-user flag rather than a
-- case_memberships role. System administrators can always create cases
-- regardless of this flag; this flag lets a non-admin (e.g. a case manager
-- persona) create cases too. When a non-admin creates a case they are
-- automatically added as its case_manager.
-- Idempotent: safe to re-run.

ALTER TABLE users ADD COLUMN IF NOT EXISTS can_create_cases BOOLEAN NOT NULL DEFAULT FALSE;
