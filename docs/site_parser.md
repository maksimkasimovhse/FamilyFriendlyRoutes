# Парсер сайтов для каталога

## Назначение

Парсер работает offline при обновлении каталога. Онлайн-рекомендация не загружает сайты. На вход подаётся URL из предварительно проверенного реестра источников, на выходе получаются кандидаты `Place`, `Activity` и `EventOccurrence` с доказательствами. Канонические `place_id` и `activity_id` назначаются позже после entity resolution; LLM их не генерирует.

## Поток обработки

1. Оператор добавляет источник в локальный `data/source_registry.json`: `source_id`, разрешённые host, статус, лимит ответа и политику robots.txt. Пример — [`data/source_registry.example.json`](../data/source_registry.example.json).
2. Задание ingestion передаёт `source_id + URL`. Произвольный URL вне allowlist отклоняется; приватные и loopback-адреса запрещены.
3. Fetcher проверяет robots.txt, ограничивает редиректы и размер, принимает SSR HTML. Страница, где содержимое появляется только после JavaScript, получает отдельный разрешённый browser-adapter; автоматический обход защиты не допускается.
4. HTML очищается от навигации, скриптов и форм. Сохраняются final/canonical URL, время получения, SHA-256, основной текст и JSON-LD hints.
5. Сначала используются структурированные данные и правила. Очищенный текст и hints передаются в GigaChat как недоверенные данные.
6. GigaChat возвращает JSON по строгой схеме [`site_schema.py`](../models/site_schema.py). Pydantic повторно проверяет типы, enum, диапазоны и обязательность evidence.
7. Каждая цитата ищется в реально переданном `visible_text` или `json_ld` согласно `source_part`. Несуществующая цитата, другой URL или факт без evidence отклоняют результат.
8. Нормализатор разрешает противоречия, приводит даты к RFC3339 с `Europe/Moscow`, а локальное время — к `HH:MM`. Затем выполняются сопоставление сущностей, ручная проверка спорных claims и публикация версии каталога.

PDF, JSON/API и JavaScript-страницы должны иметь отдельные адаптеры получения, но после нормализации используют ту же extraction schema.

Минимальное внутреннее задание имеет вид:

```json
{
  "job_id": "ingestion-job-opaque-id",
  "source_id": "official-museum-site",
  "url": "https://official.example/programs/lab",
  "document_type": "html",
  "requested_at": "2026-11-20T12:00:00+03:00"
}
```

Один job обрабатывает одну страницу. Sitemap или страница-афиша могут создать список отдельных job, но crawler не обходит весь домен без лимита и явного правила source adapter.

## Разделение временных полей

| Поле | Смысл | Пример |
| --- | --- | --- |
| `place.opening_hours` | Регулярные часы доступности места | понедельник 10:00–18:00 |
| `activity.occurrences[].start_at/end_at` | Конкретный сеанс или событие | 2026-12-01 12:00–13:00 MSK |
| `activity.duration_minutes` | Заявленная длительность посещения | мастер-класс длится 60 минут |

Если страница говорит только «начало в 12:00», `end_at` и длительность не выдумываются. Если указаны начало и конец, вычисленная длительность добавляется детерминированным нормализатором, а не LLM. Часы работы музея нельзя автоматически присваивать отдельному мероприятию.

## Выход extraction

Сокращённый синтетический пример:

```json
{
  "schema_version": "1.0",
  "source_url": "https://example.org/events/lab",
  "page_title": "Лаборатория",
  "place": {
    "source_name": "Семейный центр",
    "name_evidence": [{
      "quote": "Семейный центр",
      "source_url": "https://example.org/events/lab",
      "source_part": "visible_text"
    }],
    "address": null,
    "address_evidence": [],
    "opening_hours": [
      {
        "day_of_week": "monday",
        "opens": "10:00",
        "closes": "18:00",
        "evidence": [{
          "quote": "По понедельникам работаем с 10:00 до 18:00",
          "source_url": "https://example.org/events/lab",
          "source_part": "visible_text"
        }]
      }
    ]
  },
  "activities": [
    {
      "source_title": "Научная лаборатория",
      "activity_type": "session",
      "description": "Интерактивное занятие с опытами для детей.",
      "description_evidence": [{
        "quote": "Интерактивное занятие с опытами для детей",
        "source_url": "https://example.org/events/lab",
        "source_part": "visible_text"
      }],
      "topics": ["science"],
      "topic_evidence": [{
        "quote": "занятие с опытами",
        "source_url": "https://example.org/events/lab",
        "source_part": "visible_text"
      }],
      "formats": ["educational"],
      "format_evidence": [{
        "quote": "Интерактивное занятие",
        "source_url": "https://example.org/events/lab",
        "source_part": "visible_text"
      }],
      "duration_minutes": 60,
      "duration_evidence": [{
        "quote": "Продолжительность — 60 минут",
        "source_url": "https://example.org/events/lab",
        "source_part": "visible_text"
      }],
      "age_rules": [],
      "occurrences": [],
      "booking_required": null,
      "booking_evidence": []
    }
  ],
  "warnings": []
}
```

## Передача в RecSys и Planner

RecSys получает `description`, `topics`, `formats`, возрастной профиль и маски неизвестности. `description` используется для embedding/content matching, но не заменяет атомарные факты. Ranker использует интерес, возрастную пригодность, query match и популярность.

Planner получает часы работы, конкретные occurrences, длительность и booking status. Расписание не повышает тематический интерес; оно отвечает только за выполнимость маршрута. Поля с `null` не превращаются в отрицательные значения.

## GigaChat

Интеграция использует `POST /v2/chat/completions` и `model_options.response_format.type=json_schema`. По умолчанию выбрана `GigaChat-2-Pro`; модель можно изменить через `GIGACHAT_MODEL`. OAuth-токен обновляется локально, ключ читается из `GIGACHAT_CREDENTIALS`, TLS-проверка не отключается.

Запуск после создания проверенного реестра и настройки окружения:

```bash
cp data/source_registry.example.json data/source_registry.json
# Отредактировать registry: официальный host и enabled=true.
export GIGACHAT_CREDENTIALS='...'
export GIGACHAT_CA_BUNDLE='/path/to/russian_trusted_root_ca.pem'
python scripts/extract_site.py 'https://official.example/program' \
  --source-id official-example --output data/processed/catalog/program.json
```
