FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app:/app/models

WORKDIR /app
COPY services/model_service/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt \
    && useradd --create-home --uid 10001 appuser

COPY models/place_ranker.py models/query_match.py models/request_schema.py models/taxonomy.py /app/models/
COPY models/recommendation_engine.py models/baseline_query.py models/age_band_policy.py /app/models/
COPY models/recommendation_context.py models/model_contracts.py /app/models/
COPY models/recommendation_policy.json /app/models/
COPY data/catalog/city/catalog.jsonl /app/data/catalog/city/catalog.jsonl
COPY data/catalog/enriched/catalog.jsonl /app/data/catalog/enriched/catalog.jsonl
COPY docs/contracts/openapi.json /app/docs/contracts/openapi.json
COPY shared /app/shared
COPY services/__init__.py /app/services/__init__.py
COPY services/model_service /app/services/model_service

USER appuser
EXPOSE 8080
CMD ["uvicorn", "services.model_service.app:app", "--host", "0.0.0.0", "--port", "8080"]
