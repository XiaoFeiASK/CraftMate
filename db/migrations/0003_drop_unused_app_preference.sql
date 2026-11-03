-- The console stores UI-only preferences in localStorage, so the server never
-- reads this table. 0002 created it and was already applied on existing
-- installs; dropping it here keeps history append-only.
DROP TABLE app_preference;
