package main

import (
	"context"
	"errors"
	"flag"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/assistant"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/httpapi"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/mapdata"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/planner"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/routing"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/tripstore"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/wishes"
)

func main() {
	listen := flag.String("listen", "127.0.0.1:8080", "Development backend address")
	allowNetwork := flag.Bool("allow-network-listen", false, "Allow binding container network interfaces; publish ports on loopback")
	trustProxy := flag.Bool("trust-proxy-headers", false, "Trust HTTPS protocol set by our reverse proxy; backend must not be publicly exposed")
	routingURL := flag.String("routing-url", "http://127.0.0.1:8002", "Valhalla base URL")
	database := flag.String("store", "data/backend/state.json", "Single-process development store")
	demo := flag.Bool("demo-catalog", false, "Explicitly enable synthetic integration activities, NOT real venue data")
	imagesDir := flag.String("images-dir", "assets/images", "Directory with card images served under /media/")
	mlURL := flag.String("ml-url", "", "Full internal ML recommendations endpoint")
	catalogVersion := flag.String("catalog-version", "", "Catalog version agreed with ML")
	parserURL := flag.String("parser-url", "", "parser-service base URL (LLM request parsing); empty = keyword parser only")
	modelURL := flag.String("model-url", "", "model-service base URL (ranking); empty = local ranking only")
	cardTags := flag.String("card-tags", "data/card_tags.json", "Card tags for wish-based selection (scripts/build-card-tags.py)")
	keywords := flag.String("wish-keywords", "data/wish_keywords.json", "Keyword stems for wish parsing")
	assistantURL := flag.String("assistant-url", os.Getenv("ASSISTANT_URL"), "Internal contextual LLM endpoint")
	initialLLM := flag.Bool("initial-llm", os.Getenv("INITIAL_LLM_ENABLED") == "true", "Enable initial contextual parsing")
	healthcheck := flag.Bool("healthcheck", false, "Check the local Go API and exit")
	flag.Parse()
	if *healthcheck {
		if err := checkBackendHealth("http://127.0.0.1:8080/healthz"); err != nil {
			log.Fatal(err)
		}
		return
	}
	if *demo == (*mlURL != "") || (!*demo && *catalogVersion == "") {
		log.Fatal("Choose -demo-catalog OR -ml-url <endpoint> -catalog-version <version>.")
	}
	host, _, err := net.SplitHostPort(*listen)
	ip := net.ParseIP(host)
	if err != nil || ip == nil || !ip.IsLoopback() && !*allowNetwork {
		log.Fatal("Non-loopback binding requires -allow-network-listen")
	}
	manifest, err := routing.LoadManifest("data/routing/source-manifest.json")
	if err != nil {
		log.Fatal(err)
	}
	router, err := routing.NewClient(*routingURL, manifest.RoutingDataVersion, nil)
	if err != nil {
		log.Fatal(err)
	}
	store, err := tripstore.Open(*database)
	if err != nil {
		log.Fatal(err)
	}
	p := planner.Planner{Router: router}
	if *demo {
		p.Activities = planner.DemoActivities()
	} else {
		p.Source = planner.HTTPSource{Endpoint: *mlURL, Version: *catalogVersion, Token: os.Getenv("ML_API_TOKEN")}
		alternatives := map[string]planner.CandidateSource{}
		if endpoint := os.Getenv("LEGACY_ML_URL"); endpoint != "" {
			alternatives["mock-ml-v1"] = planner.HTTPSource{Endpoint: endpoint, Version: "mock-ml-v1", Token: os.Getenv("ML_API_TOKEN")}
		}
		if endpoint, version := os.Getenv("CITY_ML_URL"), os.Getenv("CITY_CATALOG_VERSION"); endpoint != "" && version != "" {
			alternatives[version] = planner.HTTPSource{Endpoint: endpoint, Version: version, Token: os.Getenv("ML_API_TOKEN")}
		}
		if len(alternatives) > 0 {
			p.Source = planner.CatalogSources{Default: p.Source, Versions: alternatives}
		}
	}
	if _, err := os.Stat(*imagesDir); err != nil {
		log.Fatalf("images-dir: %v", err)
	}
	root := http.NewServeMux()
	var mapRepository mapdata.Repository
	if databaseURL := os.Getenv("DATABASE_URL"); databaseURL != "" {
		config, err := pgxpool.ParseConfig(databaseURL)
		if err != nil {
			log.Fatal("Invalid DATABASE_URL")
		}
		config.MaxConns = 8
		config.ConnConfig.ConnectTimeout = 5 * time.Second
		pool, err := pgxpool.NewWithConfig(context.Background(), config)
		if err != nil {
			log.Fatal("Cannot initialize catalog database pool")
		}
		defer pool.Close()
		probe, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		err = pool.Ping(probe)
		cancel()
		if err != nil {
			log.Fatal("Catalog database unavailable; check DATABASE_URL and PostgreSQL")
		}
		mapRepository = mapdata.Postgres{Pool: pool}
	}
	root.Handle("/api/v1/map/places", httpapi.MapHandler(mapRepository))
	root.Handle("GET /api/v1/trips/{trip_id}/map/places", httpapi.RouteMapHandler(store, mapRepository))
	root.Handle("/media/", httpapi.MediaHandler(*imagesDir))
	if kw, err := wishes.LoadKeywords(*keywords); err != nil {
		log.Printf("wishes disabled: %v", err)
	} else if tags, err := wishes.LoadCardTags(*cardTags); err != nil {
		log.Printf("wishes disabled: %v", err)
	} else {
		rec := wishes.NewRecommender(kw, tags, wishes.Services{ParserURL: *parserURL, ModelURL: *modelURL})
		root.Handle("/api/v1/wishes/recommendations", httpapi.WishesHandler(rec))
	}
	var interpreter assistant.Interpreter
	if *assistantURL != "" {
		interpreter = assistant.HTTPInterpreter{Endpoint: *assistantURL, Token: os.Getenv("ML_API_TOKEN")}
	}
	if *initialLLM {
		if interpreter == nil {
			log.Fatal("initial-llm requires assistant-url")
		}
		p.Interpreter = interpreter
	}
	root.Handle("/", httpapi.TripHandlerWithAssistant(store, p, interpreter, mapRepository))
	var handler http.Handler = root
	if *trustProxy {
		handler = httpapi.TrustedProxyHTTPS(handler)
	}
	server := &http.Server{Addr: *listen, Handler: handler, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 70 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 * 1024}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	log.Printf("Backend http://%s (1..14 days, demo_catalog=%t, real OSM paths)", *listen, *demo)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
