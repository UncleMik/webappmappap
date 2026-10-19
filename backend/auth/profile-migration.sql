-- Apply to the existing auth PostgreSQL database before publishing the profile API.
ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS profile jsonb;
