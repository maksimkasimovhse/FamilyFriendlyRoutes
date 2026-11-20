-- +goose Up
CREATE TABLE item_tags (
  item_id  integer  NOT NULL REFERENCES items ON DELETE CASCADE,
  tag_id   smallint NOT NULL REFERENCES tags,
  weight   real NOT NULL DEFAULT 1 CHECK (weight BETWEEN 0 AND 1),  -- насколько тег характерен
  PRIMARY KEY (item_id, tag_id)
);
CREATE INDEX item_tags_tag_idx ON item_tags (tag_id, item_id);

-- Проверяемые факты с происхождением (Fact<T> из контракта).
-- Отсутствие строки означает «неизвестно».
-- Ключи: indoor, toilet, shelter, seating, stroller_friendly, wheelchair_accessible,
--        changing_table, age_min_years, age_max_years, recommended_age_min_years,
--        recommended_age_max_years, height_min_cm, admission_rule, booking_required,
--        duration_min, visit_mode.
CREATE TABLE item_facts (
  item_id       integer NOT NULL REFERENCES items ON DELETE CASCADE,
  fact_key      text NOT NULL,
  value         jsonb NOT NULL,                 -- true / false / число / строка
  source        text NOT NULL CHECK (source IN ('official', 'osm', 'estimated', 'user', 'model')),
  confidence    real CHECK (confidence BETWEEN 0 AND 1),
  evidence_ids  text[] NOT NULL DEFAULT '{}',   -- ссылки на подтверждения
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, fact_key)
);

-- +goose Down
DROP TABLE item_facts;
DROP TABLE item_tags;
