"""Export real OSM infrastructure from the existing PBF. Requires osmium.

python scripts/extract-infrastructure.py --pbf data/routing/nizhny-novgorod.osm.pbf
Nodes retain their location; ways use the centre of their bounding box, NOT an entrance.
Relations are not extracted. Coverage is a bounding box, not a municipal boundary.
"""
import argparse
import collections
import json
from pathlib import Path
import osmium

parser = argparse.ArgumentParser()
parser.add_argument('--pbf', default='data/routing/nizhny-novgorod.osm.pbf')
parser.add_argument('--manifest', default='data/routing/source-manifest.json')
parser.add_argument('--output', default='data/infrastructure/osm-infrastructure.geojson')
parser.add_argument('--bbox', default='43.6,56.15,44.2,56.43')
args = parser.parse_args()
west, south, east, north = map(float, args.bbox.split(','))
manifest = json.loads(Path(args.manifest).read_text(encoding='utf-8-sig'))
features = []

def category(tags):
    if tags.get('leisure') == 'playground': return 'playground'
    if tags.get('leisure') == 'park': return 'park'
    return {'bench':'bench', 'toilets':'toilet', 'pharmacy':'pharmacy',
            'cafe':'restaurant', 'restaurant':'restaurant'}.get(tags.get('amenity'))

class Export(osmium.SimpleHandler):
    def emit(self, obj, kind, lon, lat, geometry_source):
        if not (west <= lon <= east and south <= lat <= north): return
        tags = dict(obj.tags)
        if tags.get('access') in ('private','no'): return
        features.append({'type':'Feature','geometry':{'type':'Point','coordinates':[lon,lat]},
                         'properties':{'osm':f'{"node" if geometry_source == "osm_node" else "way"}/{obj.id}', 'kind':kind,
                                       'name':tags.get('name:ru') or tags.get('name'),
                                       'geometry_source':geometry_source, 'tags':tags}})
    def node(self, obj):
        kind = category(obj.tags)
        if kind and obj.location.valid(): self.emit(obj,kind,obj.location.lon,obj.location.lat,'osm_node')
    def way(self, obj):
        kind = category(obj.tags)
        if not kind: return
        points = [(n.lon,n.lat) for n in obj.nodes if n.location.valid()]
        if len(points) != len(obj.nodes) or not points: return
        self.emit(obj,kind,(min(p[0] for p in points)+max(p[0] for p in points))/2,
                  (min(p[1] for p in points)+max(p[1] for p in points))/2,'way_bbox_center')

Export().apply_file(args.pbf,locations=True)
features.sort(key=lambda f:f['properties']['osm'])
result = {'type':'FeatureCollection','attribution':'© OpenStreetMap contributors, ODbL 1.0',
          'source_url':manifest['source_url'],'checked_at':manifest['downloaded_at'],
          'bbox':[west,south,east,north],'features':features,
          'note':'OSM snapshot; not verified on site. Way centres are not entrances; relations omitted.'}
out = Path(args.output)
out.parent.mkdir(parents=True,exist_ok=True)
out.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps(dict(collections.Counter(f['properties']['kind'] for f in features)),ensure_ascii=False))
