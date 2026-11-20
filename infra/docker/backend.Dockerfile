# Сборка Go-бекенда Максима без установки Go на компьютер.
FROM golang:1.26 AS build
WORKDIR /src
COPY go.mod ./
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 go build -o /out/backend ./cmd/backend

FROM gcr.io/distroless/static-debian12
# Бекенд читает data/routing/source-manifest.json и пишет data/backend/state.json
# относительно рабочей папки, поэтому ./data монтируется в /app/data.
WORKDIR /app
COPY --from=build /out/backend /usr/local/bin/backend
ENTRYPOINT ["backend", "-demo-catalog"]
