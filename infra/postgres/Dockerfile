# PostgreSQL 16 с pgvector (halfvec требует >= 0.7) и PostGIS.
# Базовый образ pgvector поддерживает amd64 и arm64; PostGIS ставится из репозитория PGDG.
FROM pgvector/pgvector:pg16
RUN apt-get update \
    && apt-get install -y --no-install-recommends postgresql-16-postgis-3 postgresql-16-postgis-3-scripts \
    && rm -rf /var/lib/apt/lists/*
