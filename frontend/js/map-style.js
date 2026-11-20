// Стиль карты: светлый Positron от OpenFreeMap, перекрашенный под макеты
// (design/pages/legacy-ekrany-semeyny-nizhny.html): спокойный тёплый фон,
// голубая вода, зелень только в парках, белые дороги, мягкие светлые 3D-дома.
// Яркие акценты (маршрут, кремль, удобства) рисуем поверх в map.js.

const BASE_STYLE = 'https://tiles.openfreemap.org/styles/positron';

// Подписи — по-русски (по умолчанию стиль пишет латиницу + кириллицу)
const RUSSIAN_NAME = ['coalesce', ['get', 'name:ru'], ['get', 'name']];

export const COLORS = {
  background: '#F5F2EC',  // земля — тёплый светлый
  residential: '#F1EDE5',
  water: '#BFDDF6',       // Волга и Ока, как на макете
  park: '#D7ECC6',
  wood: '#C8E4B2',
  buildingTop: '#FFF4E3',   // тёплый светлый — под светом не уходит в серый
  roadMajor: '#FFFFFF',
  roadMinor: '#FFFFFF',
  roadCasing: '#E4DED3',
  rail: '#D3CCBF',
  label: '#4A4F5C',
  waterLabel: '#3D7DB8',
};

function recolor(layer) {
  const id = layer.id;
  const paint = layer.paint = layer.paint || {};
  if (layer.type === 'background') paint['background-color'] = COLORS.background;
  if (layer.type === 'fill') {
    if (id.includes('water')) paint['fill-color'] = COLORS.water;
    else if (id.includes('wood')) paint['fill-color'] = COLORS.wood;
    else if (id.includes('park')) paint['fill-color'] = COLORS.park;
    else if (id.includes('residential')) paint['fill-color'] = COLORS.residential;
  }
  if (layer.type === 'line') {
    if (id.includes('water')) paint['line-color'] = COLORS.water;
    else if (id.includes('casing')) paint['line-color'] = COLORS.roadCasing;
    else if (id.includes('highway')) paint['line-color'] = (id.includes('minor') || id.includes('path')) ? COLORS.roadMinor : COLORS.roadMajor;
    else if (id.includes('rail')) paint['line-color'] = COLORS.rail;
  }
  if (layer.type === 'symbol') {
    paint['text-color'] = id.includes('water') ? COLORS.waterLabel : COLORS.label;
    paint['text-halo-color'] = '#FFFFFF';
    if (layer.layout && layer.layout['text-field']) layer.layout['text-field'] = RUSSIAN_NAME;
  }
}

// 3D-здания: светлые, почти без теней — объём есть, но карта не «тяжёлая»
const BUILDINGS_3D = {
  id: 'building-3d',
  type: 'fill-extrusion',
  source: 'openmaptiles',
  'source-layer': 'building',
  minzoom: 14,
  paint: {
    'fill-extrusion-color': COLORS.buildingTop,
    'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 6],
    'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
    'fill-extrusion-opacity': 0.95,
    'fill-extrusion-vertical-gradient': false,
  },
};

export async function loadMapStyle() {
  const style = await (await fetch(BASE_STYLE)).json();
  style.layers.forEach(recolor);
  // Плоские здания убираем — вместо них объёмные. Ставим их под подписи.
  style.layers = style.layers.filter(l => l.id !== 'building');
  const firstLabel = style.layers.findIndex(l => l.type === 'symbol');
  style.layers.splice(firstLabel, 0, BUILDINGS_3D);
  // Мягкий свет сверху: стены зданий почти не темнеют
  style.light = { anchor: 'viewport', color: '#ffffff', intensity: 0.1, position: [1.5, 90, 30] };
  return style;
}
