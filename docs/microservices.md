# Pipeline микросервисов

## Границы

```text
                     offline catalog flow
approved URL ──> parser-service ──> reviewed catalog snapshot ──> backend/catalog
                      │
                      └── GigaChat API

                      online recommendation flow
request_text ──> parser-service ──> ParsedRequest ─┐
                                                   ├──> model-service ──> ranked activity_id[]
catalog/profile/features ──────────────────────────┘
```

`parser-service` — единственный из двух сервисов, который загружает сайты и обращается к GigaChat. Он не назначает канонические ID и не ранжирует места.

`model-service` не имеет credentials GigaChat и не загружает URL. Он принимает только канонические `activity_id`, признаки семьи/активности и проверенный `ParsedRequest`; применяет eligibility, query matching, score и MMR.

Backend остаётся оркестратором: хранит каталог и версии, вызывает parser для свободного текста, собирает признаки кандидатов и вызывает model-service. Parser и model-service не пишут напрямую в общую БД.

## Внутренние endpoint’ы

| Сервис | Метод | Путь | Назначение |
| --- | --- | --- | --- |
| parser | GET | `/health` | readiness процесса |
| parser | POST | `/internal/v1/request-parses` | текст → закрытые claims |
| parser | POST | `/internal/v1/catalog-extractions` | разрешённый URL → кандидаты каталога с evidence |
| model | GET | `/health` | readiness процесса |
| model | POST | `/internal/v1/rankings` | признаки кандидатов + claims → ранжированный список |

Все запросы несут `contract_version="1.0"` и `request_id`. В production к ним нужно добавить service authentication/mTLS, tracing и retry policy; Compose публикует порты только на localhost. Контейнеры работают non-root и с read-only root filesystem.

## Запуск

Без GigaChat можно проверить model-service и границу DTO:

```bash
docker compose up --build -d
python scripts/demo_microservices.py \
  --parsed-fixture data/fixtures/parsed_request_animals.json
```

Для реального parser-service:

```bash
cp data/source_registry.example.json data/source_registry.json
# Настроить allowlist и enabled=true.
cp compose.override.example.yaml compose.override.yaml
export GIGACHAT_CREDENTIALS='...'
export GIGACHAT_CA_FILE='/absolute/host/path/to/ca.pem'
docker compose up --build -d

python scripts/demo_microservices.py
```

Override монтирует `GIGACHAT_CA_FILE` в контейнер как `/run/secrets/gigachat-ca.pem`. Пример намеренно не отключает TLS verification.

Проверка здоровья:

```bash
curl http://127.0.0.1:8081/health
curl http://127.0.0.1:8082/health
```

## Что ещё потребуется перед production

- заменить синхронный catalog extraction на очередь job/worker для больших обходов;
- хранилище raw document и идемпотентность по content hash;
- entity resolution и ручная публикация claims в catalog snapshot;
- authentication между сервисами, rate limits, OpenTelemetry;
- retries/circuit breaker для GigaChat, dead-letter queue;
- обученная локальная модель интереса и возрастные метки вместо части baseline-компонентов.
