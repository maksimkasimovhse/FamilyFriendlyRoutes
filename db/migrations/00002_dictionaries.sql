-- +goose Up
CREATE TABLE catalog_versions (
  version     text PRIMARY KEY,                 -- версия загруженного каталога, например '2026-11-20'
  created_at  timestamptz NOT NULL DEFAULT now(),
  note        text
);

CREATE TABLE categories (
  category_id smallint PRIMARY KEY,
  item_type   item_type NOT NULL,               -- к какому типу относится категория
  slug        text NOT NULL,                    -- латинский код: 'museums'
  name_ru     text NOT NULL,                    -- название для пользователя
  sort_order  smallint NOT NULL DEFAULT 0,      -- порядок в списках
  UNIQUE (item_type, slug),
  UNIQUE (item_type, name_ru)
);

CREATE TABLE map_layers (                       -- как категория рисуется на карте
  category_id    smallint PRIMARY KEY REFERENCES categories,
  icon           text NOT NULL,                 -- имя иконки маркера
  color          text NOT NULL CHECK (color ~ '^#[0-9A-Fa-f]{6}$'),
  min_zoom       smallint NOT NULL DEFAULT 10,  -- с какого масштаба объекты видны
  z_order        smallint NOT NULL DEFAULT 0,   -- порядок наложения
  is_highlighted boolean NOT NULL DEFAULT false,-- подсвечивать на карте (функционал обсуждается)
  is_active      boolean NOT NULL DEFAULT true  -- слой включён
);

CREATE TABLE tags (
  tag_id     smallint PRIMARY KEY,
  slug       text NOT NULL UNIQUE,              -- 'animals', 'italian'
  name_ru    text NOT NULL,
  tag_group  text NOT NULL
             CHECK (tag_group IN ('theme', 'activity', 'audience', 'cuisine', 'feature', 'object_kind'))
);

-- +goose Down
DROP TABLE tags;
DROP TABLE map_layers;
DROP TABLE categories;
DROP TABLE catalog_versions;
