CREATE TABLE IF NOT EXISTS auth_stars_ai_daily_usage (
 user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
 day_moscow date NOT NULL, used integer NOT NULL DEFAULT 0 CHECK(used BETWEEN 0 AND 10),
 PRIMARY KEY(user_id,day_moscow)
);
CREATE TABLE IF NOT EXISTS auth_stars_ai_reservations (
 user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
 request_id uuid NOT NULL, day_moscow date NOT NULL,
 free_units integer NOT NULL CHECK(free_units BETWEEN 0 AND 2),
 paid_units integer NOT NULL CHECK(paid_units BETWEEN 0 AND 2),
 refunded boolean NOT NULL DEFAULT false,
 CHECK(free_units+paid_units BETWEEN 1 AND 2),
 PRIMARY KEY(user_id,request_id)
);
