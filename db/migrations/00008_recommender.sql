-- +goose Up
-- Признаки для ранжирования; пересчитываются из фактов, тегов и текста.
CREATE TABLE item_features (
  item_id               integer PRIMARY KEY REFERENCES items ON DELETE CASCADE,
  computed_at           timestamptz NOT NULL DEFAULT now(),
  quality_score         real CHECK (quality_score BETWEEN 0 AND 1),
  embedding             halfvec(384),           -- вектор описания; размерность зависит от модели
  duration_min          smallint,               -- сколько обычно занимает посещение
  age_min               smallint,               -- разрешённый возраст
  age_max               smallint,
  age_rec_min           smallint,               -- рекомендуемый возраст
  age_rec_max           smallint,
  price_level           smallint CHECK (price_level BETWEEN 0 AND 4),   -- 0 бесплатно … 4 дорого
  physical_load         smallint CHECK (physical_load BETWEEN 1 AND 5), -- 1 спокойно … 5 много ходьбы
  season_mask           smallint NOT NULL DEFAULT 15 CHECK (season_mask BETWEEN 0 AND 15),
                                                -- биты: 1 зима, 2 весна, 4 лето, 8 осень
  daypart_mask          smallint NOT NULL DEFAULT 7 CHECK (daypart_mask BETWEEN 0 AND 7),
                                                -- биты: 1 утро, 2 день, 4 вечер
  indoor                boolean,                -- в помещении
  shelter               boolean,                -- есть укрытие от дождя
  toilet                boolean,
  seating               boolean,
  stroller_friendly     boolean,
  wheelchair_accessible boolean,
  changing_table        boolean,
  embedding_model       text,
  features_version      text NOT NULL
);
CREATE INDEX item_features_embedding_idx ON item_features
  USING hnsw (embedding halfvec_cosine_ops);

-- Агрегаты поведения; часто обновляются.
CREATE TABLE item_stats (
  item_id      integer PRIMARY KEY REFERENCES items ON DELETE CASCADE,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  popularity   real NOT NULL DEFAULT 0 CHECK (popularity BETWEEN 0 AND 1),
                                                -- с затуханием по времени
  impressions  integer NOT NULL DEFAULT 0,      -- показы
  clicks       integer NOT NULL DEFAULT 0,
  saves        integer NOT NULL DEFAULT 0,      -- добавления в избранное
  in_trips     integer NOT NULL DEFAULT 0,      -- попадания в поездки
  ctr          real GENERATED ALWAYS AS (clicks::real / NULLIF(impressions, 0)) STORED
) WITH (fillfactor = 70);                       -- запас в страницах для быстрых обновлений

-- Накопленные предпочтения гостевой сессии.
CREATE TABLE family_profiles (
  session_id          uuid PRIMARY KEY,         -- совпадает с гостевой сессией API
  updated_at          timestamptz NOT NULL DEFAULT now(),
  interest_embedding  halfvec(384),             -- усреднённый вектор интересов
  tag_weights         jsonb NOT NULL DEFAULT '{}',   -- {"tag_id": вес}
  child_ages          smallint[] NOT NULL DEFAULT '{}'
);

-- Контекст хранится один раз на выдачу, а не в каждом событии.
CREATE TABLE recommendation_requests (
  request_id     uuid PRIMARY KEY,
  created_at     timestamptz NOT NULL DEFAULT now(),
  session_id     uuid NOT NULL,
  model_version  text NOT NULL,                 -- какая модель сформировала выдачу
  context        jsonb NOT NULL DEFAULT '{}'    -- возраст детей, время, погода, позиция на карте
);
CREATE INDEX recommendation_requests_session_idx ON recommendation_requests (session_id, created_at);

-- Сырые события для обучения; партиции по месяцам.
CREATE TABLE interaction_events (
  created_at  timestamptz NOT NULL DEFAULT now(),
  event_id    bigint GENERATED ALWAYS AS IDENTITY,
  item_id     integer NOT NULL REFERENCES items,
  session_id  uuid NOT NULL,
  request_id  uuid,
  kind        smallint NOT NULL CHECK (kind BETWEEN 1 AND 6),
                                                -- 1 показ, 2 клик, 3 сохранение, 4 добавление в поездку, 5 пропуск, 6 скрытие
  position    smallint,                         -- позиция в выдаче
  PRIMARY KEY (created_at, event_id)
) PARTITION BY RANGE (created_at);
CREATE INDEX interaction_events_item_idx    ON interaction_events (item_id, created_at);
CREATE INDEX interaction_events_session_idx ON interaction_events (session_id, created_at);

-- DEFAULT-партиция принимает события вне созданных диапазонов, чтобы запись не падала.
CREATE TABLE interaction_events_default PARTITION OF interaction_events DEFAULT;
CREATE TABLE interaction_events_2026_11 PARTITION OF interaction_events
  FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE interaction_events_2026_12 PARTITION OF interaction_events
  FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');
CREATE TABLE interaction_events_2027_01 PARTITION OF interaction_events
  FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');

-- +goose Down
DROP TABLE interaction_events;
DROP TABLE recommendation_requests;
DROP TABLE family_profiles;
DROP TABLE item_stats;
DROP TABLE item_features;
