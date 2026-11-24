-- TownScan のスキーマ（Postgres 17。拡張なし）。何度流しても同じになる形（IF NOT EXISTS）。
-- api の起動時とローダーの実行時に適用する（app/db.py の apply_schema。アドバイザリロックで同時実行を直列にする）。
-- ログイン（Better Auth）の表は auth.sql。同じ仕組みで、このファイルのあとに、同じトランザクションで流す。
--
-- 仕様（docs/spec-prototype.md §4.3）からの違いは 1 点だけ: areas・candidates の主キーを (run_id, id) にした。
-- id は run ごとに同じ値（z18-x-y、c-x-y-n）になるので、id 単独の主キーでは run を複数持てない。

CREATE TABLE IF NOT EXISTS runs (
    run_id      text PRIMARY KEY,
    kind        text NOT NULL CHECK (kind IN ('real', 'synthetic')),
    created_at  timestamptz NOT NULL,
    model       text,
    params      jsonb NOT NULL DEFAULT '{}'::jsonb,
    notes       text
);

CREATE TABLE IF NOT EXISTS areas (
    run_id        text NOT NULL REFERENCES runs (run_id) ON DELETE CASCADE,
    id            text NOT NULL,
    z             integer NOT NULL,
    x             integer NOT NULL,
    y             integer NOT NULL,
    west          double precision NOT NULL,
    south         double precision NOT NULL,
    east          double precision NOT NULL,
    north         double precision NOT NULL,
    centroid_lon  double precision NOT NULL,
    centroid_lat  double precision NOT NULL,
    name          text,
    ward          text,
    municipality  text,
    name_source   text,
    PRIMARY KEY (run_id, id)
);

CREATE TABLE IF NOT EXISTS buildings (
    id         bigserial PRIMARY KEY,
    run_id     text NOT NULL,
    area_id    text NOT NULL,
    year       integer NOT NULL,
    area_m2    double precision NOT NULL,
    prob_mean  double precision,
    geom       jsonb NOT NULL,
    FOREIGN KEY (run_id, area_id) REFERENCES areas (run_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS buildings_run_area_year_idx ON buildings (run_id, area_id, year);

CREATE TABLE IF NOT EXISTS candidates (
    id            text NOT NULL,
    run_id        text NOT NULL,
    area_id       text NOT NULL,
    class         text NOT NULL CHECK (class IN ('confirmed_new', 'existing_omission', 'uncertain')),
    area_m2       double precision NOT NULL,
    west          double precision NOT NULL,
    south         double precision NOT NULL,
    east          double precision NOT NULL,
    north         double precision NOT NULL,
    centroid_lon  double precision NOT NULL,
    centroid_lat  double precision NOT NULL,
    geom          jsonb NOT NULL,
    evidence      jsonb NOT NULL DEFAULT '{}'::jsonb,
    reason        text NOT NULL,
    PRIMARY KEY (run_id, id),
    FOREIGN KEY (run_id, area_id) REFERENCES areas (run_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS candidates_run_area_class_idx ON candidates (run_id, area_id, class);

CREATE TABLE IF NOT EXISTS metrics (
    run_id  text PRIMARY KEY REFERENCES runs (run_id) ON DELETE CASCADE,
    body    jsonb NOT NULL
);
