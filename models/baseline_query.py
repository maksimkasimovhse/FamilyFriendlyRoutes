"""Conservative offline matching of explicit soft preferences, without an LLM."""

import re

from request_schema import ParsedRequest


PATTERNS = {
    ("interest", "animals"): r"животн\w*|зоопарк\w*",
    ("interest", "nature"): r"природ\w*",
    ("interest", "science"): r"наук\w*|эксперимент\w*",
    ("interest", "space"): r"космос\w*|планетар\w*",
    ("interest", "history"): r"истори\w*",
    ("interest", "art"): r"искусств\w*|рисован\w*",
    ("interest", "technology"): r"техник\w*|робот\w*",
    ("interest", "transport"): r"транспорт\w*|поезд\w*|паровоз\w*",
    ("interest", "crafts"): r"рем[её]сл\w*|лепк\w*",
    ("category", "museum"): r"музе\w*",
    ("category", "park"): r"парк\w*",
    ("category", "event"): r"театр\w*|спектакл\w*",
    ("format", "active"): r"активн\w*",
    ("format", "calm"): r"спокойн\w*",
    ("format", "playful"): r"игр\w*",
}


def parse_baseline_text(text: str) -> ParsedRequest:
    """Only short, explicit clauses are accepted; unsupported prose is exposed.

    This adapter is a bounded MVP alternative to waiting on an online LLM.
    It never interprets age, dates, admissions or named mandatory places.
    """
    claims = []
    unsupported = []
    for clause in re.split(r"[,;.!?]|\b(?:но|а|зато)\b", text, flags=re.I):
        clause = clause.strip()
        if not clause:
            continue
        # Do not guess the scope of mixed requests or additive negation.
        if len(clause) > 160 or re.search(r"\d|не\s+только|кроме|если|не\s+против", clause, re.I):
            unsupported.append(clause[:300])
            continue
        matches = []
        for (kind, value), pattern in PATTERNS.items():
            for match in re.finditer(r"\b(?:" + pattern + r")\b", clause, re.I):
                prefix = clause[:match.start()]
                polarity = "avoid" if re.search(r"\b(?:без|не)\b", prefix, re.I) else "prefer"
                matches.append((match.start(), {"kind": kind, "value": value, "polarity": polarity,
                                                "evidence": clause}))
        # A negation appearing mid-clause can refer to only some terms.
        if matches and (len({m[1]["polarity"] for m in matches}) > 1 or (
            re.search(r"\b(?:без|не)\b", clause, re.I) and all(m[1]["polarity"] == "prefer" for m in matches)
        )):
            unsupported.append(clause)
            continue
        if not matches:
            unsupported.append(clause[:300])
        for _, claim in sorted(matches, key=lambda m: m[0]):
            if claim not in claims:
                claims.append(claim)
    return ParsedRequest(taxonomy_version="1.0", claims=claims[:20], needs_clarification=False,
                         clarification_question=None, unsupported_requests=unsupported[:10])
