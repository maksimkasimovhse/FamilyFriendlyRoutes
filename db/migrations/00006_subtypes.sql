-- +goose Up
-- Подтип мест: как объект осматривают (снаружи или внутри).
CREATE TABLE place_details (
  item_id              integer PRIMARY KEY REFERENCES items ON DELETE CASCADE,
  visit_mode           text CHECK (visit_mode IN ('outdoor', 'indoor', 'both')),
                                                -- outdoor: только снаружи; indoor: только внутри; both: можно и так, и так
                                                -- NULL: ещё не размечено
  outside_only_ok      boolean,                 -- достаточно осмотреть снаружи
  open_access          boolean,                 -- можно подойти в любое время, графика нет
  ticket_required      boolean,                 -- для входа внутрь нужен билет
  outside_duration_min smallint CHECK (outside_duration_min > 0),
  inside_duration_min  smallint CHECK (inside_duration_min > 0)
);
CREATE INDEX place_details_mode_idx ON place_details (visit_mode);

CREATE TABLE restaurant_details (
  item_id               integer PRIMARY KEY REFERENCES items ON DELETE CASCADE,
  avg_check_rub         integer,                -- средний чек на человека
  price_level           smallint CHECK (price_level BETWEEN 1 AND 4),  -- 1 дёшево … 4 дорого
  play_area_min_age     smallint,               -- возрастные границы детской зоны
  play_area_max_age     smallint,
  children_menu         boolean,                -- детское меню
  small_portions        boolean,                -- маленькие порции
  high_chairs           boolean,                -- детские стулья
  changing_table        boolean,                -- пеленальный столик
  play_area             boolean,                -- есть детская зона
  play_area_supervision boolean,                -- присмотр в детской зоне
  takes_reservations    boolean                 -- принимает бронь
);                                              -- кухня хранится тегами с tag_group = 'cuisine'

-- Событие как сущность: спектакль, концерт, выставка.
CREATE TABLE event_details (
  item_id           integer PRIMARY KEY REFERENCES items ON DELETE CASCADE,
  duration_min      smallint,                   -- длительность одного сеанса
  age_rating        smallint CHECK (age_rating IN (0, 6, 12, 16, 18)),
  booking_required  boolean,
  organizer         text,
  ticket_url        text
);

-- Конкретные даты и места проведения.
CREATE TABLE event_occurrences (
  occurrence_id  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  starts_at      timestamptz NOT NULL,
  ends_at        timestamptz,
  event_id       integer NOT NULL REFERENCES event_details ON DELETE CASCADE,
  venue_id       integer NOT NULL REFERENCES items,   -- место проведения (item типа place)
  price_min_rub  integer,
  price_max_rub  integer,
  status         text NOT NULL DEFAULT 'scheduled'
                 CHECK (status IN ('scheduled', 'cancelled')),
  booking_status text NOT NULL DEFAULT 'unknown'
                 CHECK (booking_status IN ('available', 'sold_out', 'unknown')),
  CHECK (ends_at IS NULL OR ends_at >= starts_at)
);
CREATE INDEX event_occurrences_time_idx  ON event_occurrences (starts_at) WHERE status = 'scheduled';
CREATE INDEX event_occurrences_event_idx ON event_occurrences (event_id, starts_at);
CREATE INDEX event_occurrences_venue_idx ON event_occurrences (venue_id, starts_at);

-- +goose Down
DROP TABLE event_occurrences;
DROP TABLE event_details;
DROP TABLE restaurant_details;
DROP TABLE place_details;
