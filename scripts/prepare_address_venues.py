"""Create an explicit publisher venue using a strictly matched building address."""
import json,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"scripts"));sys.path.insert(0,str(ROOT/"models"))
from export_all_places import blank
from source_matching import normalize_name


def build():
    source=ROOT/"data/processed/site_collection/geocoding/v_tishine_structured.json"
    if not source.exists():return
    saved=json.loads(source.read_text())
    valid=[]
    for r in saved["results"]:
        a=r.get("address",{})
        if a.get("house_number")=="2" and "верхне" in normalize_name(a.get("road","")) and "волж" in normalize_name(a.get("road","")) and a.get("city")=="Нижний Новгород":valid.append(r)
    if len(valid)!=1:raise ValueError("No unique exact building address; do not assign a street midpoint")
    r=valid[0]
    row=blank("place:publisher:vtishine-nn","В Тишине","museum",float(r["lon"]),float(r["lat"]))
    row.update(source_dataset="publisher",source_id="vtishine-nn",address="Нижний Новгород, Верхне-Волжская набережная, 2",
               source_url="https://nn.burocultura.ru/events/v-tishine-neobychnaya-poznavatelnaya-ekskursiya",
               mvp_status="new_source_candidate",mvp_reason="Address-level building point; entrance and business identity not field-verified.",
               location_accuracy="address_building",possible_parent_place_ids=["place:main:116"],
               quality_flags=["ADDRESS_POINT_NOT_ENTRANCE","PUBLISHER_VENUE_UNVERIFIED","POSSIBLE_COLOCATION_WITH_EXISTING_BUILDING"],
               sources=[{"dataset":"publisher_event_location","url":"https://nn.burocultura.ru/events/v-tishine-neobychnaya-poznavatelnaya-ekskursiya"},
                        {"dataset":"nominatim","source_url":saved["source_url"],"fetched_at":saved["fetched_at"],"result":r}])
    out=ROOT/"data/enriched/address_venues";out.mkdir(parents=True,exist_ok=True)
    (out/"places.jsonl").write_text(json.dumps(row,ensure_ascii=False)+"\n")
    print("1 publisher venue linked to an exact building address; GRANAT street-only result rejected")


if __name__=="__main__":build()
