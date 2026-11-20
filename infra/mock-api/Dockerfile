# МОК по контрактам (рекомендации ML + места на карте). Только стандартная библиотека Python.
FROM python:3.12-alpine
WORKDIR /app
COPY server.py catalog.json places.json ./
ENTRYPOINT ["python", "-u", "server.py"]
