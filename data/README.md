# Данные для рекомендательной системы

Исходные выгрузки лежат в `data/raw/` и исключены из Git. Их состояние и SHA-256 записаны в `audit.json`; повторить проверку можно командой `python scripts/audit_datasets.py > data/audit.json` (для Parquet нужен `pyarrow`). Файл `audit.json` описывает конкретные байты локальной копии, а не гарантирует качество меток.

| Источник | Роль | Локальный файл | Условия и ограничения |
| --- | --- | --- | --- |
| [Stravl Travel Preference Data](https://github.com/Stravl/Stravl-Data) | Явные ответы Yes/No/Maybe и анкета для эксперимента с профилем интересов | `raw/stravl/Stravl_Travel_Preference_Data.csv`, `destination_ids.txt` | Автор разрешает академическое и коммерческое использование в README. Объекты — направления путешествий, не активности Нижнего. `form_b` содержит бюджет из источника и **не используется** как вход продукта или признак модели v1. |
| [Geo Reviews Dataset 2023](https://github.com/yandex/geo-reviews-dataset-2023) через [зеркало на Hugging Face](https://huggingface.co/datasets/d0rj/geo-reviews-dataset-2023) | Русскоязычные отзывы для извлечения тем и признаков объектов | `raw/geo_reviews_2023/train.parquet` | Оригинальный репозиторий объявляет MIT; зеркало воспроизводит 500 000 строк и пять заявленных полей. Тождество отдельных записей оригинальной выгрузке не проверено. Отзыв и рейтинг не являются меткой возрастной пригодности ребёнку. Данные относятся к 2023 году. |
| [OpenStreetMap через Geofabrik](https://download.geofabrik.de/russia/volga-fed-district.html) | Географическая основа для будущего каталога мест Нижнего Новгорода | `raw/osm_nizhny/volga-fed-district-261117.osm.pbf` | Снимок всего Приволжского округа от 17.11.2026, ODbL 1.0, © OpenStreetMap contributors. Город ещё не выделен, активности, расписания и возрастные правила не проверены. |

Для обучения на Stravl нужно исключать строки без ответов и разбирать 318 пользователей, у которых один ID направления попал в разные классы ответа. Train/validation/test разделяются по `id` пользователя; `Maybe` хранится отдельно, непоказанные направления не становятся отрицательными примерами. Переход от направлений Stravl к активностям Нижнего требует собственных проверенных описаний и меток, прямой join по ID невозможен.

`python scripts/prepare_stravl.py` создаёт в `data/processed/stravl/` файлы `interactions.parquet`, `profiles.parquet`, `destinations.csv` и `report.json`. Он удаляет 1 331 конфликтующую пару «пользователь × направление», сохраняет остальные ответы и делит пользователей на train/validation/test по стабильному хешу ID (80/10/10 по бакетам). `form_b` не попадает в подготовленные профили. [Отчёт подготовки](stravl_preparation_report.json) сохранён отдельно от больших файлов.

`python scripts/filter_geo_nizhny.py` создаёт `data/processed/geo_reviews_2023/nizhny_address_matches.parquet` с 8 645 строками. Фильтр основан только на написании адреса, поэтому это пул для проверки и разметки, а не готовый каталог активностей.

Первый эксперимент с общей моделью интереса и отдельным компонентом возрастной пригодности описан в [`models/README.md`](../models/README.md). Он обучен на ответах Stravl; этот источник не содержит точных меток пригодности для групп 3–5/6–8/9–11.

В `labels/age_fit_template.csv` лежит пустой шаблон для ручной оценки пары «активность × возрастная группа» с источником и проверяющим; правила и шкала 0/0.25/0.5/0.75/1 описаны в [`labels/age_fit_guidelines.md`](labels/age_fit_guidelines.md). `participation_allowed=forbidden` является hard-фактом и не получает мягкий `age_fit`; для остальных строк `age_fit` может оставаться пустым. Никакие строки не сгенерированы как вымышленные факты. `python scripts/prepare_age_fit_labels.py` проверяет разметку и делит её по `activity_id`, чтобы одна активность не попала в разные выборки.

`python scripts/export_age_review_candidates.py` выгружает 74 найденных regex-скринингом отзыва в `processed/age_fit/review_candidates.csv` для ручной проверки. Это очередь кандидатов, не автоматические метки: упоминание возраста в отзыве само по себе не доказывает пригодность места.

`fixtures/ranking_candidates.json` — синтетический smoke-test baseline ranker, а не реальные места каталога. ID намеренно демонстрационные; fixture проверяет hard-фильтрацию, неизвестные возрастные данные и компоненты score до появления верифицированного каталога.

`fixtures/microservice_candidates.json` и `fixtures/parsed_request_animals.json` проверяют HTTP-границу model-service без платного LLM-вызова. Это синтетические DTO, не строки продуктового каталога.

Запрос `queries/nizhny_poi.overpassql` сохранён для локального POI-среза. Публичный Overpass при проверке вернул HTTP 406 или не ответил за 120 секунд; PBF от Geofabrik выбран как воспроизводимый источник для следующего этапа извлечения.

Скачивание закреплённых версий:

```bash
mkdir -p data/raw/stravl data/raw/geo_reviews_2023 data/raw/osm_nizhny
curl -fL -o data/raw/stravl/Stravl_Travel_Preference_Data.csv https://raw.githubusercontent.com/Stravl/Stravl-Data/d65ddabb912761d09fd2c417d2a5b248b7b678f6/Stravl_Travel_Preference_Data.csv
curl -fL -o data/raw/stravl/destination_ids.txt https://raw.githubusercontent.com/Stravl/Stravl-Data/d65ddabb912761d09fd2c417d2a5b248b7b678f6/destination_ids.txt
curl -fL -o data/raw/geo_reviews_2023/train.parquet https://huggingface.co/datasets/d0rj/geo-reviews-dataset-2023/resolve/02366bc66bd43aa69e707747487ec8f3c22cac84/data/train-00000-of-00001-49261e4e5a35a5a0.parquet
curl -fL -o data/raw/osm_nizhny/volga-fed-district-261117.osm.pbf https://download.geofabrik.de/russia/volga-fed-district-261117.osm.pbf
python scripts/audit_datasets.py > data/audit.json
```
