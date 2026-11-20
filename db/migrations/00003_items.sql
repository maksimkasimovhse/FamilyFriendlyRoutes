-- +goose Up
-- Колонки расставлены по убыванию размера, чтобы не терять место на выравнивании.
CREATE TABLE items (
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  item_id         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                                                -- в API отдаётся строкой; стабилен при перезагрузке данных
  item_type       item_type NOT NULL,
  category_id     smallint NOT NULL REFERENCES categories,
  show_in_cards   boolean NOT NULL,             -- выводить как карточку (false для addition)
  show_on_map     boolean NOT NULL DEFAULT true,-- показывать на карте
  is_published    boolean NOT NULL DEFAULT true,-- мягкое скрытие без удаления
  title           text NOT NULL,
  source_dataset  text NOT NULL,                -- 'main', 'addition', 'restaurants', 'events'
  source_id       text NOT NULL,                -- id в исходном наборе
  catalog_version text NOT NULL REFERENCES catalog_versions,
  UNIQUE (source_dataset, source_id)            -- ключ идемпотентной загрузки
);
CREATE INDEX items_cards_idx ON items (item_type, category_id)
  WHERE is_published AND show_in_cards;
CREATE INDEX items_map_idx ON items (category_id)
  WHERE is_published AND show_on_map;
CREATE INDEX items_title_trgm_idx ON items USING gin (title gin_trgm_ops);

-- Тяжёлый текст отдельно от горячей таблицы.
CREATE TABLE item_content (
  item_id          integer PRIMARY KEY REFERENCES items ON DELETE CASCADE,
  description_html text NOT NULL,               -- как в источнике (<p>, <br>), уходит на фронт
  search_vector    tsvector GENERATED ALWAYS AS (
                     to_tsvector('russian'::regconfig, regexp_replace(description_html, '<[^>]+>', ' ', 'g'))
                   ) STORED                     -- полнотекстовый поиск по описанию
);
CREATE INDEX item_content_fts_idx ON item_content USING gin (search_vector);

-- Исходная строка для аудита и пересборки.
CREATE TABLE item_raw (
  item_id     integer PRIMARY KEY REFERENCES items ON DELETE CASCADE,
  raw         jsonb NOT NULL,                   -- строка CSV целиком
  source_file text NOT NULL,
  loaded_at   timestamptz NOT NULL DEFAULT now()
);

-- +goose Down
DROP TABLE item_raw;
DROP TABLE item_content;
DROP TABLE items;
