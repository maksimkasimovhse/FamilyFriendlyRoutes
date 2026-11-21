"""Serving acceptance checks against the real compiled source catalog."""
import json
import os
import unittest
import tempfile
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
from recommendation_engine import (RecommendationEngine, RecommendationError, ENRICHED_CATALOG_PATH,
    ENRICHED_CATALOG_VERSION, SUPPORTED_PURPOSES)
from recommendation_context import calendar_for, route_distance_m
from services.model_service.app import app, recommendation_engine
from test_recommendation_engine import sample_request, make_engine

ROOT = Path(__file__).resolve().parents[1]
AS_OF = datetime(2026,11,21,tzinfo=timezone.utc)


def request_for(purpose="initial"):
    r = sample_request()
    r.update(catalog_version=ENRICHED_CATALOG_VERSION,purpose=purpose)
    return r


class RecSysScenarios(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.engine = RecommendationEngine(ROOT/ENRICHED_CATALOG_PATH,ROOT/'docs/contracts/openapi.json',
                                         ROOT/'models/recommendation_policy.json',ENRICHED_CATALOG_VERSION)

    def recommend(self,r):
        return self.engine.recommend(r,now=AS_OF)

    def test_all_backend_purposes_have_contract_valid_distinct_results(self):
        for purpose in SUPPORTED_PURPOSES:
            with self.subTest(purpose=purpose):
                response = self.recommend(request_for(purpose))
                self.assertGreater(len(response['candidates']),0)
                self.engine.validators['RecommendationResponse'].validate(response)
                self.assertEqual(len({c['place']['place_id'] for c in response['candidates']}),len(response['candidates']))
                for c in response['candidates']:
                    kind=c['activity']['kind']
                    if purpose=='restaurant': self.assertEqual(kind,'meal')
                    credit=sum(v['value'] for v in c['balance_credit'])
                    self.assertAlmostEqual(credit,0 if kind in {'meal','rest','utility'} else 1)

    def test_children_menu_requires_evidence_for_the_specific_place(self):
        r=request_for('restaurant');r['restaurant_filters']={'children_menu':True}
        response=self.recommend(r)
        names={c['place']['name'] for c in response['candidates']}
        self.assertIn('Митрич',names);self.assertIn('Мама дома',names)
        self.assertNotIn('Хачапурия',names)
        evidence={e['evidence_id'] for e in response['evidence']}
        for c in response['candidates']:
            fact=c['place']['restaurant']['children_menu']
            self.assertIs(fact['value'],True)
            self.assertTrue(set(fact['evidence_ids'])<=evidence)
        r['restaurant_filters']={'children_menu':True,'small_portions':True}
        self.assertEqual(self.recommend(r)['status'],'no_candidates')

    def test_explicit_text_menu_filter_and_branch_ambiguity(self):
        r=request_for('restaurant');r['request_text']='Кафе с детским меню'
        self.assertTrue(all(c['place']['restaurant']['children_menu']['value'] is True for c in self.recommend(r)['candidates']))
        r['request_text']=None;r['restaurant_filters']={'play_area':True}
        self.assertEqual([c['place']['name'] for c in self.recommend(r)['candidates']],['Митрич'])

    def test_nearby_radius_and_empty_search_are_real_filters(self):
        r=request_for('restaurant');point={'coordinates':[44.0059,56.3269],'label':None}
        r['spatial_scope']={'center':point,'radius_m':500,'route':None,'corridor_width_m':None}
        result=self.recommend(r)
        self.assertTrue(result['candidates'])
        self.assertTrue(all(c['place']['distance_m']<=500 for c in result['candidates']))
        r['spatial_scope']['radius_m']=0
        self.assertEqual(self.recommend(r)['status'],'no_candidates')

    def test_corridor_uses_segments_and_no_artificial_connector(self):
        self.assertLess(route_distance_m([44,56.3],[[43.99,56.3],[44.01,56.3]]),1)
        r=request_for('along_route')
        r['spatial_scope']={'center':None,'radius_m':None,'route':None,'corridor_width_m':100,
            'routes':[{'type':'LineString','coordinates':[[44.005,56.326],[44.015,56.33]]},
                      {'type':'LineString','coordinates':[[43.8,56.2],[43.81,56.21]]}]}
        response=self.recommend(r)
        self.assertTrue(response['candidates'])
        self.assertTrue(all(c['place']['distance_to_route_m']<=100 for c in response['candidates']))

    def test_invalid_spatial_pairs_and_selection_outside_scope_are_explicit(self):
        r=request_for();r['spatial_scope']={'center':None,'radius_m':500,'route':None,'corridor_width_m':None}
        with self.assertRaises(RecommendationError) as e:self.recommend(r)
        self.assertEqual(e.exception.code,'INVALID_REQUEST')
        row=self.engine.records[0]
        r['selections']=[dict(activity_id=row['activity']['activity_id'],place_id=row['place']['place_id'],mandatory=True,occurrence_id=None,preferred_date=None)]
        r['spatial_scope']={'center':{'coordinates':[43.5,56.05],'label':None},'radius_m':0,'route':None,'corridor_width_m':None}
        with self.assertRaises(RecommendationError) as e:self.recommend(r)
        self.assertEqual(e.exception.code,'SELECTION_CONFLICT')

    def event_request(self):
        row=next(row for row in self.engine.records if row['activity']['kind']=='session' and not row['api']['activity'].get('participation_rules_raw'))
        occurrence=row['occurrences'][0];day=occurrence['start_at'][:10]
        r=request_for();r['days'][0].update(date=day,available_window={'start_at':day+'T09:00:00+03:00','end_at':day+'T20:00:00+03:00'})
        r['selections']=[dict(activity_id=row['activity']['activity_id'],place_id=row['place']['place_id'],mandatory=True,preferred_date=day,occurrence_id=occurrence['occurrence_id'])]
        r['limit']=1
        return r,row,occurrence

    def test_fixed_session_reaches_the_contract_without_fabricated_availability(self):
        r,row,o=self.event_request();response=self.recommend(r);c=response['candidates'][0]
        self.assertEqual(c['activity']['kind'],'session')
        self.assertEqual(c['activity']['duration']['source'],'official')
        self.assertEqual(c['activity']['booking_required']['state'],'unknown')
        self.assertEqual(c['activity']['age_min_years']['state'],'unknown') # 6+ is a label, not admission.
        av=c['availability'][0]
        self.assertEqual(av['state'],'open')
        self.assertIn(o['occurrence_id'],[x['occurrence_id'] for x in av['occurrences']])
        self.assertTrue(all(x['booking_status']=='unknown' for x in av['occurrences']))
        self.assertTrue(set(av['evidence_ids'])<={e['evidence_id'] for e in response['evidence']})

    def test_expired_wrong_or_unsuitable_occurrence_cannot_be_selected(self):
        r,row,o=self.event_request()
        for occurrence_id in ['missing',o['occurrence_id']]:
            with self.subTest(occurrence_id=occurrence_id):
                r['selections'][0]['occurrence_id']=occurrence_id
                with self.assertRaises(RecommendationError) as e:
                    self.engine.recommend(r,now=datetime(2031,1,1,tzinfo=timezone.utc))
                self.assertEqual(e.exception.code,'SELECTION_CONFLICT')

    def test_two_activities_of_same_place_do_not_silently_overwrite_selection(self):
        row=next(r for r in self.engine.records if r['activity']['kind']=='session')
        visit=next(r for r in self.engine.records if r['place']['place_id']==row['place']['place_id'] and r['activity']['kind']=='visit')
        r=request_for()
        r['selections']=[dict(activity_id=x['activity']['activity_id'],place_id=x['place']['place_id'],mandatory=True,preferred_date=None,occurrence_id=None) for x in [row,visit]]
        with self.assertRaises(RecommendationError) as e:self.recommend(r)
        self.assertEqual(e.exception.code,'SELECTION_CONFLICT')

    def test_overnight_hours_split_at_midnight_and_omitted_day_remains_unknown(self):
        row={'activity':{'kind':'meal'},'schedules':[{'usable':True,'intervals':[{'day_of_week':'friday','opens':'22:00','closes':'02:00','end_day_offset':1}],'evidence_ids':['hours']} ]}
        av=calendar_for(row,['2026-11-20','2026-11-21','2026-11-22'],AS_OF)
        self.assertEqual(av[1]['visit_windows'][0]['start_at'],'2026-11-21T00:00:00+03:00')
        self.assertEqual(av[1]['visit_windows'][0]['end_at'],'2026-11-21T02:00:00+03:00')
        self.assertEqual(av[2]['state'],'unknown')
        other=deepcopy(row['schedules'][0]);other['intervals'][0]['closes']='04:00';row['schedules'].append(other)
        self.assertEqual(calendar_for(row,['2026-11-21'],AS_OF)[0]['state'],'unknown')

    def test_service_accepts_new_and_saved_catalog_versions(self):
        recommendation_engine.cache_clear()
        with patch.dict(os.environ,{'MODEL_CATALOG_VERSION':ENRICHED_CATALOG_VERSION,'MODEL_CATALOG_PATH':'','ML_API_TOKEN':'scenario-token','REQUEST_PARSER_URL':''}),TestClient(app) as client:
            health=client.get('/ready').json()
            self.assertEqual(health['catalog_version'],ENRICHED_CATALOG_VERSION)
            self.assertEqual(set(health['purposes']),set(SUPPORTED_PURPOSES))
            for request in [request_for('restaurant'),sample_request()]:
                response=client.post('/internal/v1/recommendations',json=request,headers={'Authorization':'Bearer scenario-token'})
                self.assertEqual(response.status_code,200,response.text)
        recommendation_engine.cache_clear()

    def test_bad_nested_evidence_cannot_pass_catalog_readiness(self):
        row=deepcopy(next(r for r in self.engine.records if r['api']['place']['restaurant'] is not None))
        row['api']['place']['restaurant']['children_menu']={'state':'known','value':True,'evidence_ids':['missing-evidence']}
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'catalog.jsonl';path.write_text(json.dumps(row))
            with self.assertRaisesRegex(ValueError,'missing evidence'):
                RecommendationEngine(path,ROOT/'docs/contracts/openapi.json',ROOT/'models/recommendation_policy.json',ENRICHED_CATALOG_VERSION)


if __name__=='__main__':unittest.main()
