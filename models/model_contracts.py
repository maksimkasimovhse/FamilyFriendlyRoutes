"""ML-only optional input extensions; the backend's OpenAPI file stays unchanged."""
from copy import deepcopy
from request_schema import ParsedRequest


def recommendation_schemas(backend_spec: dict) -> dict:
    schemas = deepcopy(backend_spec["components"]["schemas"])
    parsed = ParsedRequest.model_json_schema(ref_template="#/components/schemas/ML{model}")
    definitions = parsed.pop("$defs", {})
    schemas.update({"ML" + key: value for key, value in definitions.items()})
    schemas["MLParsedRequest"] = parsed
    schemas["RecommendationRequest"]["properties"]["parsed_request"] = {
        "anyOf": [{"$ref": "#/components/schemas/MLParsedRequest"}, {"type": "null"}],
    }
    return schemas
