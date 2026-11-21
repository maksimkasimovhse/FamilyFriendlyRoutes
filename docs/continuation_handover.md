# Передача проекта FamilyFriendlyRoutes

Актуальная ветка: `main`. Последний рабочий коммит перед созданием этого документа — `a024bf1`.

## Что развёрнуто

- Публичное приложение: `http://51.250.0.195`.
- VM: пользователь `votter`, рабочая копия `/home/votter/FamilyFriendlyRoutes`.
- Обновление из `origin/main` выполняет systemd timer `family-routes-deploy.timer`; сервис обновления — `family-routes-deploy.service`.
- Проверка API парсера: `http://51.250.0.195/parser/health`.
- Парсер не публикует произвольный URL: принимает только домены из локального allowlist `data/source_registry.json`.

## GigaChat и парсер

- Используется `GigaChat-3-Pro`, B2B scope, TLS verification не отключена.
- Ключ и `.env` не хранятся в Git и не должны передаваться в архиве. Новому оператору нужен свой ключ или безопасная передача действующего ключа отдельным каналом.
- Нужны переменные `GIGACHAT_CREDENTIALS`, `GIGACHAT_SCOPE=GIGACHAT_API_B2B`, `GIGACHAT_MODEL=GigaChat-3-Pro`, `GIGACHAT_CA_FILE`.
- Сертификат Минцифры передаётся в пакете как `infra/docker/certs/russian_trusted_root_ca_pem.crt`; контейнер получает его через `compose.override.yaml` на VM.
- Реальный smoke test страницы НГХМ прошёл: получены 7 активностей и 6 интервалов работы; claims без точной цитаты из страницы отбрасываются.

## Данные и модели

- OSM-каталог: 1 000 точек Нижнего Новгорода, `data/enriched/osm_nizhny_1000/`.
- Очередь источников: `source_discovery_queue.csv` содержит 216 URL-кандидатов, включая 194 URL из OSM, 5 из Wikidata P856, 8 из ТЗ и 9 вручную подтверждённых поиском кандидатов.
- `source_registry_candidates.json` содержит 170 выключенных доменов-кандидатов. Ничего из него нельзя включать массово без проверки ownership, robots.txt и редиректов.
- Обученные/подготовленные артефакты в передаваемом пакете: age-fit labels, Stravl datasets, geo-review match, checkpoint-файлы.

## Безопасный порядок продолжения

1. Распаковать пакет в корень свежей рабочей копии репозитория. Он содержит только игнорируемые данные и конфигурацию без секретов.
2. Создать `.env` из `.env.example`, заполнить секреты безопасным каналом и установить права `0600`.
3. Проверить `data/source_registry.json`; там включён только домен НГХМ для smoke test.
4. Для следующей партии выбрать строки из `source_discovery_queue.csv`, проверить домен и robots.txt, после чего добавить конкретный source в `data/source_registry.json` c `enabled: true`.
5. Запускать парсер по одной странице или через будущий rate-limited worker. Не обходить домен целиком и не отправлять в GigaChat непроверенные URL.
6. Для проверки развёртывания: `curl -fsS http://127.0.0.1:8081/health` на VM и `docker compose ps`.

## Как обновить источник-кандидат

```bash
python scripts/build_source_discovery_queue.py
# Обновить только снимок P856 из Wikidata:
python scripts/build_source_discovery_queue.py --refresh-wikidata
```

Поиск официальных сайтов остаётся отдельным этапом entity resolution. Инфраструктура (скамейки, туалеты, укрытия) обычно не имеет собственного сайта: для неё OSM остаётся первичным источником, а отсутствие URL не означает отсутствие объекта.

## Что не включено в пакет

- `.env`, OAuth credentials и access tokens;
- runtime-кэш Python и `__pycache__`;
- запущенные Docker-контейнеры и базы VM.

Бэкап базы данных не создавался по договорённости: на VM используется существующий резервный механизм.
