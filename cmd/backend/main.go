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
)

func main() {
	listen := flag.String("listen", "127.0.0.1:8080", "Development backend address")
	allowNetwork := flag.Bool("allow-network-listen", false, "Allow binding container network interfaces; publish ports on loopback")
	routingURL := flag.String("routing-url", "http://127.0.0.1:8002", "Valhalla base URL")
	database := flag.String("store", "data/backend/state.json", "Single-process development store")
	demo := flag.Bool("demo-catalog", false, "Explicitly enable synthetic integration activities, NOT real venue data")
	imagesDir := flag.String("images-dir", "assets/images", "Directory with card images served under /media/")
	mlURL := flag.String("ml-url", "", "Full internal ML recommendations endpoint")
	catalogVersion := flag.String("catalog-version", "", "Catalog version agreed with ML")
	assistantURL := flag.String("assistant-url", os.Getenv("ASSISTANT_URL"), "Internal contextual LLM intent endpoint")
	flag.Parse()
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
	var interpreter assistant.Interpreter
	if *assistantURL != "" {
		interpreter = assistant.HTTPInterpreter{Endpoint: *assistantURL, Token: os.Getenv("ML_API_TOKEN")}
	}
	root.Handle("/", httpapi.TripHandlerWithAssistant(store, p, interpreter, mapRepository))
	server := &http.Server{Addr: *listen, Handler: root, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 70 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 * 1024}
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
