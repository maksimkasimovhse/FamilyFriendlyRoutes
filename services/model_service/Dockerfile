FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app:/app/models

WORKDIR /app
COPY services/model_service/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt \
    && useradd --create-home --uid 10001 appuser

# Все модули models/*.py: recommendation_engine импортирует age_band_policy, baseline_query, model_contracts, recommendation_context
COPY models/*.py models/recommendation_policy.json /app/models/
COPY services/model_service/catalog_recommendations.py /app/services/model_service/catalog_recommendations.py
# Движок рекомендаций сверяет ответы с контрактом
COPY docs/contracts/openapi.json /app/docs/contracts/openapi.json
COPY shared /app/shared
COPY services/__init__.py /app/services/__init__.py
COPY services/model_service /app/services/model_service

USER appuser
EXPOSE 8080
CMD ["uvicorn", "services.model_service.app:app", "--host", "0.0.0.0", "--port", "8080"]
