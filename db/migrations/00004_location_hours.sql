-- +goose Up
-- У событий записи нет: место берётся из event_occurrences.
CREATE TABLE item_location (
  item_id   integer PRIMARY KEY REFERENCES items ON DELETE CASCADE,
  location  geography(Point, 4326) NOT NULL,    -- из WKT 'POINT (lon lat)'
  entrance  geography(Point, 4326),             -- точка входа, если отличается от центра
  address   text NOT NULL,
  district  text                                -- район города
);
CREATE INDEX item_location_gix ON item_location USING gist (location);

CREATE TABLE item_contacts (
  item_id  integer PRIMARY KEY REFERENCES items ON DELETE CASCADE,
  phone    text,
  website  text
);

-- Регулярный график.
CREATE TABLE item_hours (
  item_id  integer NOT NULL REFERENCES items ON DELETE CASCADE,
  weekday  smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),  -- 1 = понедельник
  opens    time NOT NULL,
  closes   time NOT NULL,                       -- closes <= opens: закрытие после полуночи
  PRIMARY KEY (item_id, weekday, opens)         -- несколько интервалов в день допустимы
);

-- Праздники и особые дни.
CREATE TABLE item_hours_exceptions (
  item_id  integer NOT NULL REFERENCES items ON DELETE CASCADE,
  on_date  date NOT NULL,
  is_open  boolean NOT NULL,
  opens    time,
  closes   time,
  note     text,
  PRIMARY KEY (item_id, on_date)
);

-- +goose Down
DROP TABLE item_hours_exceptions;
DROP TABLE item_hours;
DROP TABLE item_contacts;
DROP TABLE item_location;
