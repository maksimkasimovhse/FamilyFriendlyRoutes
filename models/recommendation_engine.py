"""Full backend recommendation contract backed by a small local city catalog."""

from __future__ import annotations

import hashlib
import json
import math
import re
from copy import deepcopy
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker

from age_band_policy import age_fit_for_child, validate_age_fit_profile
from baseline_query import parse_baseline_text
from place_ranker import RankCandidate, RankingPolicy, rank_places
from query_match import query_match_score
from request_schema import ParsedRequest, validate_evidence
from taxonomy import FORMATS, INTEREST_IDS


MODEL_VERSION = "city-content-baseline-v1"
CATALOG_VERSION = "city-osm-v2"
CATALOG_RELATIVE_PATH = "data/catalog/city/catalog.jsonl"
UNKNOWN = {"state": "unknown", "value": None, "evidence_ids": []}
ALIASES = {
    "tech": {"interest:technology"},
    "play": {"format:playful", "format:active"},
    "museums": {"category:museum"},
    "walks": {"interest:nature", "format:active", "format:calm"},
    "local_food": {"interest:cooking", "category:restaurant"},
}


def contract_formats() -> FormatChecker:
    checker = FormatChecker()

    @checker.checks("date-time", raises=(ValueError, TypeError))
    def offset_timestamp(value):
        # jsonschema's default date-time checker requires an optional dependency.
        # Enforce the offset-bearing RFC3339 subset accepted by the Go backend.
        if not isinstance(value, str):
            return True
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})", value):
            return False
        return datetime.fromisoformat(value.replace("Z", "+00:00")).utcoffset() is not None

    return checker


class RecommendationError(ValueError):
    def __init__(self, code: str, message: str, status: int = 422):
        super().__init__(message)
        self.code, self.status = code, status


def warning(code: str, message: str, activity_id: str | None = None, *, severity: str = "warning") -> dict:
    return dict(code=code, message=message, severity=severity, place_id=None,
                activity_id=activity_id, stop_id=None, child_id=None, evidence_ids=[])


def reason(code: str, message: str, children: list[str] | None = None) -> dict:
    return dict(code=code, message=message, child_ids=children or [], evidence_ids=[])


def interest_score(interests: list[str], tags: frozenset[str]) -> tuple[float, list[str]]:
    recognized = [ALIASES.get(value, {"interest:" + value}) for value in interests
                  if value in ALIASES or value in INTEREST_IDS]
    unknown = sorted(set(interests) - set(ALIASES) - set(INTEREST_IDS))
    # Neutral for an empty/unknown profile. These are content scores, not probabilities.
    raw = sum(bool(group & tags) for group in recognized) / len(recognized) if recognized else 1.0
    return raw, unknown


class RecommendationEngine:
    def __init__(self, catalog_path: Path, contract_path: Path, policy_path: Path,
                 catalog_version: str = CATALOG_VERSION):
        raw = catalog_path.read_bytes()
        self.content_sha256 = hashlib.sha256(raw).hexdigest()
        self.catalog_version = catalog_version
        self.records = [json.loads(line) for line in raw.decode().splitlines() if line.strip()]
        json.dumps(self.records, allow_nan=False)
        self.policy = json.loads(policy_path.read_text())
        self.schemas = json.loads(contract_path.read_text())["components"]["schemas"]
        self.validators = {name: Draft202012Validator(
            {"$ref": f"#/components/schemas/{name}", "components": {"schemas": self.schemas}},
            format_checker=contract_formats(),
        ) for name in ("RecommendationRequest", "RecommendationResponse", "Place", "Activity", "Evidence", "ApiError")}
        self.by_id = {}
        places = set()
        self.evidence = {}
        if not self.records or not self.catalog_version:
            raise ValueError("catalog and catalog_version must be nonempty")
        for row in self.records:
            activity, place = row["activity"], row["place"]
            validate_age_fit_profile(activity["age_fit"])
            if not isinstance(activity["topics"], list) or not isinstance(activity["formats"], list) or (
                set(activity["topics"]) - set(INTEREST_IDS) or set(activity["formats"]) - set(FORMATS)
            ):
                raise ValueError("invalid catalog topics or formats")
            aid, pid = activity["activity_id"], place["place_id"]
            if not aid or aid in self.by_id or not pid or pid in places:
                raise ValueError("catalog must contain unique activity and place IDs")
            self.by_id[aid] = row
            places.add(pid)
            for span in row.get("evidence", []):
                self.validators["Evidence"].validate(span)
                key = span["evidence_id"]
                if key in self.evidence and self.evidence[key] != span:
                    raise ValueError("conflicting evidence ID")
                self.evidence[key] = span
        # Build all candidates at startup so malformed data cannot pass readiness.
        for row in self.records:
            p, a = self._entities(row)
            self.validators["Place"].validate(p)
            self.validators["Activity"].validate(a)
            if any(value["state"] == "known" and not set(value["evidence_ids"]) <= self.evidence.keys()
                   for container in (p, a) for value in container.values() if isinstance(value, dict) and "state" in value):
                raise ValueError("known fact references missing evidence")
            lower, upper = a["age_min_years"]["value"], a["age_max_years"]["value"]
            if lower is not None and upper is not None and lower > upper:
                raise ValueError("invalid hard age range")

    def _entities(self, row: dict) -> tuple[dict, dict]:
        place, activity = row["place"], row["activity"]
        location = place["location"]
        p = dict(place_id=place["place_id"], name=place["title"],
                 location={"coordinates": [location["longitude"], location["latitude"]], "label": place["title"]},
                 address=place.get("address"), entrance=None, categories=[place["category"]],
                 display_class="unknown", restaurant=None,
                 opening_hours_raw=place.get("opening_hours_raw"),
                 **{key: deepcopy(place.get("facts", {}).get(key, UNKNOWN)) for key in ("indoor", "toilet", "shelter", "seating")})
        estimates = self.policy["duration_estimates_sec"]
        seconds = estimates.get(place["category"], estimates["other"])
        if isinstance(seconds, bool) or not isinstance(seconds, (float, int)) or not math.isfinite(seconds) or not 0 < seconds <= 86400:
            raise ValueError("duration estimate must be positive, finite and <=86400")
        # This release supports independent visits. Event dates/sessions need an adapter.
        if activity["kind"] != "visit":
            raise ValueError("this catalog adapter supports only independent visits")
        a = dict(activity_id=activity["activity_id"], place_id=place["place_id"], title=activity["title"], kind="visit",
                 duration={"duration_sec": seconds, "source": "estimated", "evidence_ids": []},
                 evidence_ids=[entry["evidence_id"] for entry in row.get("evidence", [])])
        for field in ("age_min_years", "age_max_years", "recommended_age_min_years", "recommended_age_max_years",
                      "height_min_cm", "admission_rule", "booking_required"):
            a[field] = deepcopy(activity.get("facts", {}).get(field, UNKNOWN))
        return p, a

    def recommend(self, request: dict, parsed_request=None) -> dict:
        def finite_values(value):
            if isinstance(value, float) and not math.isfinite(value):
                return False
            if isinstance(value, dict):
                return all(finite_values(v) for v in value.values())
            if isinstance(value, list):
                return all(finite_values(v) for v in value)
            return True

        if not finite_values(request):
            raise RecommendationError("INVALID_REQUEST", "Числа должны быть конечными.")
        error = next(self.validators["RecommendationRequest"].iter_errors(request), None)
        if error:
            raise RecommendationError("INVALID_REQUEST", "Неверный запрос: " + ".".join(str(v) for v in error.absolute_path))
        if request["catalog_version"] != self.catalog_version:
            raise RecommendationError("CATALOG_VERSION_MISMATCH", "Версия каталога не совпадает.", 409)
        if request["purpose"] != "initial" or request["spatial_scope"] is not None:
            raise RecommendationError("FEATURE_DISABLED", "MVP поддерживает начальный подбор без пространственных фильтров.", 501)
        children = request["profile"]["children"]
        child_ids = [c["child_id"] for c in children]
        dates = [d["date"] for d in request["days"]]
        if len(set(child_ids)) != len(child_ids) or not dates or len(dates) > 14 or len(set(dates)) != len(dates):
            raise RecommendationError("INVALID_REQUEST", "Нужны уникальные дети и от 1 до 14 уникальных дат.")
        weights = request["policy"]["child_interest_weights"]
        if len(weights) != len(children) or {w["child_id"] for w in weights} != set(child_ids) or any(
            not math.isclose(w["weight"], 1 / len(children), abs_tol=1e-9) for w in weights
        ):
            raise RecommendationError("INVALID_POLICY", "Для интересов детей нужны равные веса.")
        excluded = set(request["excluded_activity_ids"]) | set(request["visited_activity_ids"])
        selections = request["selections"]
        selected = {s["activity_id"] for s in selections}
        if len(selected) != len(selections) or len(selected) > request["limit"]:
            raise RecommendationError("SELECTION_CONFLICT", "Выборы повторяются или превышают лимит.")
        for selection in selections:
            row = self.by_id.get(selection["activity_id"])
            if not row or row["place"]["place_id"] != selection["place_id"]:
                raise RecommendationError("UNKNOWN_ACTIVITY", "Выбранная активность отсутствует в каталоге.")
            if selection["activity_id"] in excluded or selection["occurrence_id"] is not None or (
                selection["preferred_date"] is not None and selection["preferred_date"] not in dates
            ):
                raise RecommendationError("SELECTION_CONFLICT", "Выбранная активность конфликтует с исключениями, сеансом или датой.")
        if parsed_request is None and request.get("parsed_request") is not None:
            try:
                parsed_request = ParsedRequest.model_validate(request["parsed_request"])
                validate_evidence(parsed_request, request["request_text"] or "")
            except ValueError:
                raise RecommendationError("INVALID_REQUEST", "Некорректное понимание пожеланий.") from None
        parsed = parsed_request if parsed_request is not None else parse_baseline_text(request["request_text"] or "")
        global_warnings = [warning("BASELINE_MODEL", "Подбор по тематике; модель интереса на локальных откликах ещё не обучена.", severity="info")]
        if parsed.unsupported_requests:
            global_warnings.append(warning("REQUEST_TEXT_PARTIALLY_UNDERSTOOD", "Часть пожелания не распознана; учитываются только явные темы и анкета."))
        if parsed.needs_clarification:
            raise RecommendationError("REQUEST_CLARIFICATION_REQUIRED", parsed.clarification_question)
        pool, candidates, rejected = [], {}, []
        rank_policy = replace(RankingPolicy(), adult_interest_weight=request["policy"]["adult_interest_weight"])
        for row in self.records:
            aid = row["activity"]["activity_id"]
            if aid in excluded:
                continue
            place, activity = self._entities(row)
            tags = frozenset(["category:" + row["place"]["category"]]
                             + ["interest:" + t for t in row["activity"]["topics"]]
                             + ["format:" + f for f in row["activity"]["formats"]])
            avoided = {f"{claim.kind}:{claim.value}" for claim in parsed.claims if claim.polarity == "avoid"}
            if avoided & tags and aid not in selected:
                rejected.append({"activity_id": aid, "reasons": [reason("SOFT_AVOID", "Не соответствует явно указанному пожеланию.")]})
                continue
            eligibility, interest, age_fit = {}, {}, {}
            unknown_interests = set()
            for child in children:
                cid = child["child_id"]
                blocked = activity["admission_rule"]["value"] == "forbidden"
                uncertain = activity["admission_rule"]["state"] == "unknown"
                for field, compare in (("age_min_years", lambda a, b: a < b), ("age_max_years", lambda a, b: a > b)):
                    fact = activity[field]
                    if fact["state"] == "known":
                        blocked |= compare(child["age_years"], fact["value"])
                height = activity["height_min_cm"]
                if height["state"] == "known":
                    uncertain |= child["height_cm"] is None
                    blocked |= child["height_cm"] is not None and child["height_cm"] < height["value"]
                eligibility[cid] = "ineligible" if blocked else "unknown" if uncertain else "eligible"
                interest[cid], unknown = interest_score(child["interest_ids"], tags)
                unknown_interests.update(unknown)
                age_fit[cid] = age_fit_for_child(child["age_years"], row["activity"]["age_fit"])
            if "ineligible" in eligibility.values():
                if aid in selected:
                    raise RecommendationError("HARD_CONSTRAINT_VIOLATION", "Выбранная активность запрещена одному из детей.")
                rejected.append({"activity_id": aid, "reasons": [reason("HARD_CONSTRAINT_VIOLATION", "Известное ограничение участия.")]})
                continue
            adult, unknown = interest_score(request["profile"]["adult_interest_ids"], tags)
            unknown_interests.update(unknown)
            pool.append(RankCandidate(aid, eligibility, interest, age_fit, adult, 0.5, query_match_score(parsed, tags), tags))
            notices = [warning("OPENING_HOURS_UNKNOWN", "Часы работы не подтверждены.", aid),
                       warning("DURATION_ESTIMATED", "Длительность — предварительная оценка посещения.", aid)]
            notices.extend(warning(note["code"], note["message"], aid) for note in row.get("data_quality_warnings", []))
            if avoided & tags:
                notices.append(warning("SELECTION_OVERRIDES_SOFT_AVOID", "Явно выбранное место сохранено вопреки мягкому пожеланию в тексте.", aid))
            if "unknown" in eligibility.values():
                notices.append(warning("ELIGIBILITY_UNKNOWN", "Условия допуска ребёнка не подтверждены.", aid))
            if any(v is None for v in age_fit.values()):
                notices.append(warning("AGE_FIT_UNKNOWN", "Возрастная пригодность не оценена.", aid))
            if unknown_interests:
                notices.append(warning("UNKNOWN_INTEREST_IDS", "Часть интересов не представлена в словаре и не учитывается.", aid))
            candidates[aid] = dict(place=place, activity=activity,
                availability=[dict(date=date, state="unknown", visit_windows=[], last_entry_at=None, occurrences=[], evidence_ids=[]) for date in dates],
                eligibility=[dict(child_id=cid, status=eligibility[cid], reasons=[]) for cid in child_ids],
                scores=dict(child_interest=[dict(child_id=cid, value=interest[cid] / (1 + interest[cid])) for cid in child_ids],
                            child_age_fit=[dict(child_id=cid, value=age_fit[cid]) for cid in child_ids],
                            adult_interest=adult / (1 + adult), popularity=0.5, final_relevance=0),
                balance_credit=[dict(child_id=cid, value=1 / len(children)) for cid in child_ids],
                is_top_place=False, reasons=[reason("CONTENT_BASELINE", "Совпадение интересов с темами описания; темы выделены эвристически.", child_ids)], warnings=notices)
        ranked = rank_places(pool, limit=len(pool), policy=rank_policy)
        ids = [item.activity_id for item in ranked]
        chosen = set(selected)
        for aid in ids:
            if len(chosen) >= request["limit"]:
                break
            chosen.add(aid)
        result = []
        for item in ranked:
            if item.activity_id in chosen:
                candidate = candidates[item.activity_id]
                # MMR scores are monotone, so backend's stable relevance sort preserves diversity.
                candidate["scores"]["final_relevance"] = max(0, rank_policy.mmr_lambda * item.final_relevance - (1 - rank_policy.mmr_lambda) * item.diversity_penalty)
                result.append(candidate)
        if result:
            global_warnings.append(warning("CATALOG_FACTS_INCOMPLETE", "План требует подтверждения неизвестных часов и условий посещения."))
        used_evidence = {eid for c in result for section in ("activity", "place") for f in c[section].values()
                         if isinstance(f, dict) for eid in f.get("evidence_ids", [])}
        used_evidence.update(eid for candidate in result for eid in candidate["activity"]["evidence_ids"])
        response = dict(contract_version="1.0", request_id=request["request_id"], trip_id=request["trip_id"],
                        trip_version=request["trip_version"], catalog_version=self.catalog_version, model_version=MODEL_VERSION,
                        generated_at=datetime.now(timezone.utc).isoformat(), status="partial" if result else "no_candidates",
                        candidates=result, rejected=rejected, evidence=[self.evidence[eid] for eid in sorted(used_evidence)], warnings=global_warnings)
        self.validators["RecommendationResponse"].validate(response)
        return response
