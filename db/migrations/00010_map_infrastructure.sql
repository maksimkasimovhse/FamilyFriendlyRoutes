-- +goose Up
INSERT INTO categories(category_id,item_type,slug,name_ru,sort_order) VALUES
 (30,'map_object','playgrounds','Детские площадки',40),
 (31,'map_object','benches','Скамейки',50),
 (32,'map_object','toilets','Туалеты',60),
 (33,'map_object','pharmacies','Аптеки',70),
 (34,'restaurant','cafes','Кафе и рестораны',80);
INSERT INTO map_layers(category_id,icon,color,min_zoom) VALUES
 (30,'playground','#16A085',13),(31,'bench','#795548',15),
 (32,'toilet','#2980B9',13),(33,'pharmacy','#C0392B',13),(34,'restaurant','#D35400',13);

-- Raw OSM values are exposed as raw values, never interpreted as confirmed opening times.
CREATE TABLE item_map_sources (
 item_id integer PRIMARY KEY REFERENCES items ON DELETE CASCADE,
 source_url text NOT NULL,
 source_kind text NOT NULL CHECK(source_kind IN ('osm','official','manual')),
 checked_at timestamptz NOT NULL,
 opening_hours_raw text,
 access_raw text,
 fee_raw text
);

-- +goose Down
DROP TABLE item_map_sources;
DELETE FROM map_layers WHERE category_id BETWEEN 30 AND 34;
DELETE FROM categories WHERE category_id BETWEEN 30 AND 34;
