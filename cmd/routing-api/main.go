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
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/routing"
)

func main() {
	addr := flag.String("listen", "127.0.0.1:8081", "Listen address")
	upstream := flag.String("valhalla-url", "http://127.0.0.1:8002", "Valhalla URL")
	manifestPath := flag.String("manifest", "data/routing/source-manifest.json", "OSM snapshot manifest")
	allowAnonymous := flag.Bool("allow-local-anonymous", false, "Development only, allows anonymous requests on loopback")
	flag.Parse()
	token := os.Getenv("ROUTING_API_TOKEN")
	if token == "" {
		host, _, err := net.SplitHostPort(*addr)
		ip := net.ParseIP(host)
		if !*allowAnonymous || err != nil || ip == nil || !ip.IsLoopback() {
			log.Fatal("ROUTING_API_TOKEN is required (or explicit -allow-local-anonymous with loopback listen address)")
		}
	}
	manifest, err := routing.LoadManifest(*manifestPath)
	if err != nil {
		log.Fatalf("OSM manifest: %v; run scripts/prepare-routing.ps1 first", err)
	}
	client, err := routing.NewClient(*upstream, manifest.RoutingDataVersion, nil)
	if err != nil {
		log.Fatal(err)
	}
	server := &http.Server{Addr: *addr, Handler: httpapi.Handler(client, token), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 20 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 * 1024}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	log.Printf("Routing API http://%s; OSM %s", *addr, manifest.RoutingDataVersion)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
