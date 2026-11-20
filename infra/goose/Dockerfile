# Образ с goose для применения миграций без установки Go на хосте.
FROM golang:1.26-alpine AS build
RUN CGO_ENABLED=0 go install github.com/pressly/goose/v3/cmd/goose@v3.26.0

FROM alpine:3.22
COPY --from=build /go/bin/goose /usr/local/bin/goose
ENTRYPOINT ["goose"]
