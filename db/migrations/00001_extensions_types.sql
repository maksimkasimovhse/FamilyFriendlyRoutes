-- +goose Up
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Тип объекта каталога: определяет, как он выводится и используется.
CREATE TYPE item_type AS ENUM ('place', 'restaurant', 'event', 'map_object');

-- +goose Down
DROP TYPE IF EXISTS item_type;
DROP EXTENSION IF EXISTS pg_trgm;
DROP EXTENSION IF EXISTS vector;
DROP EXTENSION IF EXISTS postgis;
