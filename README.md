# Family Friendly Routes

Семейные маршруты по Нижнему Новгороду для детей 3–11 лет. Сейчас реализован первый инфраструктурный этап: локальная маршрутизация OSM и Go-адаптер. Планировщик дней, хранение Trip и ML ещё не реализованы.

## Запуск маршрутизатора

Требования: Docker Desktop с Linux engine, Go 1.26 и PowerShell. Команды выполняются из корня репозитория.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/prepare-routing.ps1
docker compose up -d valhalla
docker compose logs -f valhalla
```

Первый скрипт скачивает OSM-выгрузку Нижегородской области (~75 МБ), сверяет MD5 провайдера, записывает SHA256 и версию данных. Повторный запуск проверяет локальный SHA256. PBF и результаты расчётов находятся в `data/routing/`, граф — в Docker volume `valhalla-data`; они не включаются в Git. Linux volume нужен для скорости чтения множества файлов на Windows. Первый запуск контейнера строит граф и занимает несколько минут; по `/status` сервис доступен после завершения сборки. Логи `docker compose logs -f` можно закрыть Ctrl+C — контейнер продолжает работать.

Valhalla закреплена по digest в compose.yaml; поддерживает pedestrian и auto на одном графе. Порты опубликованы только на 127.0.0.1.

## Проверка реальных путей

После готовности Valhalla:

```powershell
go run ./cmd/routing-smoke
```

Утилита проверяет пять пар точек в центре, для каждой — walk и car, и сохраняет `data/routing/smoke-results.json` с реальными геометриями, расстояниями, временем и версией данных. Точки — приблизительные географические пробы, не проверенные входы музеев. Скорость 3.5 км/ч задаётся явно для теста, не выводится из возраста детей.

Результаты первоначальной проверки: [10 расчётов](infra/routing/verification.json), [метаданные проверенного снимка](infra/routing/osm-source.lock.json). lock-файл фиксирует fingerprint использованных данных, но URL latest изменяется у провайдера: последующие загрузки могут иметь другой SHA256 и routing_data_version.

## Go API маршрутизации

Для локальной разработки без токена, строго на loopback:

```powershell
go run ./cmd/routing-api -allow-local-anonymous
```

Без явного флага анонимный доступ запрещён; задайте `ROUTING_API_TOKEN`, и вызывающая backend-система должна передавать `Authorization: Bearer ...`. Не публикуйте анонимный dev-сервис наружу. Пример запроса в отдельном PowerShell, когда используется анонимный локальный режим:

```powershell
$body = @{
  from = @{ coordinates = @(44.0059, 56.3269); label = $null }
  to = @{ coordinates = @(44.0095, 56.3286); label = $null }
  mode = 'walk'
  walking_speed_kph = 3.5
} | ConvertTo-Json -Depth 5
Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:8081/internal/v1/routing/route' -ContentType 'application/json' -Body $body
```

`GET /healthz` проверяет процесс, `GET /readyz` — доступность графа Valhalla. Это внутренний адаптер для будущего backend-планировщика, а не готовый публичный Trip API. Авторизация гостевой семьи и другие endpoints из основного контракта ещё не реализованы.

`mode=walk` использует pedestrian, `mode=car` — auto. Возвращаются GeoJSON `[longitude, latitude]`, метры и секунды. Пешеходная и автомобильная длительности рассчитываются отдельно. Нет вызова такси, цены, живых пробок или времени подачи. По запросу можно передать walking_speed_kph=0.5..8 для walk; без него применяется стандарт движка, это не семейная оценка темпа.

## Ограничения первого этапа

- Граф — вся область, вход API ограничен прямоугольником `[43.5,56.05,44.4,56.6]` (запад, юг, восток, север). Это техническое покрытие пилота, не административная граница города.
- Точка привязывается к сети в пределах 100 м; результат отдельно возвращает snapped_from/snapped_to. Подход от исходной точки к сети не включён в метры/секунды. Для планировщика понадобятся проверенные входы и оценка подходов; нельзя считать этот результат полным временем посещения.
- Высоты, live traffic, временные перекрытия и гарантированная физическая доступность не обеспечены. Специальный профиль коляски не реализуется.
- Admin/timezone DB не строятся; пока нет расчётов относительно даты/времени выезда. Календарная проверка часов работы остаётся задачей следующего этапа. Общая зона планировщика — Europe/Moscow.
- Расчёт по OSM не гарантирует отсутствие препятствий на местности. При отсутствии пути ошибка возвращается явно, геометрия не подменяется прямой линией.

## Обновление OSM

Остановите Go API и Valhalla перед заменой снимка:

```powershell
docker compose stop valhalla
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/prepare-routing.ps1 -Refresh
docker compose up -d --force-recreate valhalla
```

Дождитесь завершения перестроения графа, затем перезапустите Go API, чтобы он загрузил новую версию manifest. Не обновляйте PBF под работающим API: иначе версия данных и фактически загруженный граф могут разойтись. `use_tiles_ignore_pbf=False` позволяет entrypoint проверять изменения исходного PBF.

## Проверки и контракты

```powershell
go test ./...
go vet ./...
```

Тесты используют локальный HTTP-сервер: проверяют профиль движения, порядок координат, единицы измерения, ошибки, геометрию, привязку к сети и формат HTTP. Не требуют интернета, Docker или OSM. Live smoke запускается отдельно.

[Контракты](docs/contracts/README.md), [OpenAPI](docs/contracts/openapi.json).

## Источники и лицензии

Данные © OpenStreetMap contributors, [ODbL и условия атрибуции](https://www.openstreetmap.org/copyright). Выгрузка — [OpenStreetMap France, Нижегородская область](https://download.openstreetmap.fr/extracts/russia/volga_federal_district/). Будущий frontend должен показывать атрибуцию OSM. Карта-подложка не входит в этот сервис и имеет отдельные условия использования.

Документация: [официальный Docker Valhalla](https://github.com/valhalla/valhalla/blob/master/docker/README.md), [API Valhalla](https://valhalla.github.io/valhalla/api/route/api-reference/). Внешние компоненты сохраняют собственные лицензии.
