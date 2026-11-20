-- +goose Up
-- В БД только метаданные. Файлы лежат на диске и адресуются по sha256:
--   {IMAGES_ROOT}/ab/cd/<sha256>_{thumb|card|full}.webp
CREATE TABLE item_images (
  image_id    integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id     integer NOT NULL REFERENCES items ON DELETE CASCADE,
  sha256      bytea NOT NULL CHECK (octet_length(sha256) = 32),
                                                -- хеш оригинала: имя файла, ETag, защита от дублей
  width       smallint NOT NULL,                -- размер оригинала, px
  height      smallint NOT NULL,
  sort_order  smallint NOT NULL DEFAULT 0,
  is_cover    boolean NOT NULL DEFAULT false,   -- обложка карточки
  alt_text    text,
  source_url  text,                             -- откуда получена
  author      text,
  license     text,                             -- на каком праве используется
  UNIQUE (item_id, sha256)
);
CREATE UNIQUE INDEX item_images_cover_uidx ON item_images (item_id) WHERE is_cover;
CREATE INDEX item_images_item_idx ON item_images (item_id, sort_order);

-- +goose Down
DROP TABLE item_images;
