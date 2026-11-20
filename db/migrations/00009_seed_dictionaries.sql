-- +goose Up
INSERT INTO catalog_versions (version, note) VALUES ('2026-11-20', 'Начальная загрузка main.csv и addition.csv');

-- Категории мест (main.csv). Названия должны точно совпадать с CSV.
INSERT INTO categories (category_id, item_type, slug, name_ru, sort_order) VALUES
  (1,  'place',      'attractions',   'Достопримечательности',                  10),
  (2,  'place',      'museums',       'Музеи и выставочные центры',             20),
  (3,  'place',      'monuments',     'Памятники',                              30),
  (4,  'place',      'theatres',      'Театры',                                 40),
  (5,  'place',      'parks',         'Парки и места отдыха',                   50),
  (6,  'place',      'embankments',   'Набережные',                             60),
  (7,  'place',      'entertainment', 'Культурно-развлекательные организации',  70),
  -- Категории объектов карты (addition.csv).
  (20, 'map_object', 'mosaics',       'Мозаика',                                10),
  (21, 'map_object', 'tactile',       'Тактильный объект',                      20),
  (22, 'map_object', 'twin_cities',   'Города-побратимы',                       30);

-- Стили на карте. Иконки и цвета предварительные.
INSERT INTO map_layers (category_id, icon, color, min_zoom, z_order, is_highlighted) VALUES
  (1,  'landmark',  '#C0392B', 11, 50, false),
  (2,  'museum',    '#8E44AD', 11, 50, false),
  (3,  'monument',  '#7F8C8D', 12, 40, false),
  (4,  'theatre',   '#D35400', 11, 50, false),
  (5,  'park',      '#27AE60', 11, 30, false),
  (6,  'waterfront','#2980B9', 11, 30, false),
  (7,  'ticket',    '#E67E22', 12, 40, false),
  (20, 'mosaic',    '#16A085', 13, 20, true),
  (21, 'hand',      '#2C3E50', 13, 20, true),
  (22, 'handshake', '#F1C40F', 13, 20, true);

-- Виды объектов (tag_group = object_kind).
INSERT INTO tags (tag_id, slug, name_ru, tag_group) VALUES
  (1,  'monument',       'Памятник',            'object_kind'),
  (2,  'sculpture',      'Скульптура',          'object_kind'),
  (3,  'museum',         'Музей',               'object_kind'),
  (4,  'theatre',        'Театр',               'object_kind'),
  (5,  'church',         'Храм',                'object_kind'),
  (6,  'building',       'Историческое здание', 'object_kind'),
  (7,  'park',           'Парк',                'object_kind'),
  (8,  'embankment',     'Набережная',          'object_kind'),
  (9,  'viewpoint',      'Смотровая площадка',  'object_kind'),
  (10, 'mosaic',         'Мозаика',             'object_kind');

-- +goose Down
DELETE FROM tags WHERE tag_id BETWEEN 1 AND 10;
DELETE FROM map_layers;
DELETE FROM categories;
DELETE FROM catalog_versions WHERE version = '2026-11-20';
