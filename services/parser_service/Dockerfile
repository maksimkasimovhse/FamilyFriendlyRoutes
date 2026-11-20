FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app:/app/models

WORKDIR /app
COPY services/parser_service/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt \
    && useradd --create-home --uid 10001 appuser

COPY models/gigachat_client.py models/gigachat_request_parser.py models/request_schema.py /app/models/
COPY models/site_extractor.py models/site_ingestion.py /app/models/
COPY models/site_schema.py models/taxonomy.py /app/models/
COPY models/assistant_schema.py /app/models/
COPY shared /app/shared
COPY services/__init__.py /app/services/__init__.py
COPY services/parser_service /app/services/parser_service
COPY data/source_registry.example.json /app/config/source_registry.json

USER appuser
EXPOSE 8080
CMD ["uvicorn", "services.parser_service.app:app", "--host", "0.0.0.0", "--port", "8080"]
