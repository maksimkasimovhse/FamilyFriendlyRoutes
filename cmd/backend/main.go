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

	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/httpapi"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/planner"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/routing"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/tripstore"
)

func main() {
	listen := flag.String("listen", "127.0.0.1:8080", "Development backend address")
	database := flag.String("store", "data/backend/state.json", "Single-process development store")
	demo := flag.Bool("demo-catalog", false, "Explicitly enable synthetic integration activities, NOT real venue data")
	flag.Parse()
	if !*demo {
		log.Fatal("ML is not connected. For integration tests explicitly pass -demo-catalog.")
	}
	host, _, err := net.SplitHostPort(*listen)
	ip := net.ParseIP(host)
	if err != nil || ip == nil || !ip.IsLoopback() {
		log.Fatal("This development backend may only listen on loopback")
	}
	manifest, err := routing.LoadManifest("data/routing/source-manifest.json")
	if err != nil {
		log.Fatal(err)
	}
	router, err := routing.NewClient("http://127.0.0.1:8002", manifest.RoutingDataVersion, nil)
	if err != nil {
		log.Fatal(err)
	}
	store, err := tripstore.Open(*database)
	if err != nil {
		log.Fatal(err)
	}
	server := &http.Server{Addr: *listen, Handler: httpapi.TripHandler(store, planner.Planner{Router: router, Activities: planner.DemoActivities()}), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 40 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 * 1024}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	log.Printf("DEMO backend http://%s (one day, synthetic activities, real OSM paths)", *listen)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
