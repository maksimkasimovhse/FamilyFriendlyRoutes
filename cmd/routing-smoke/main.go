package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"time"

	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/routing"
)

func main() {
	upstream := flag.String("valhalla-url", "http://127.0.0.1:8002", "Valhalla URL")
	output := flag.String("output", "data/routing/smoke-results.json", "Report file")
	flag.Parse()
	manifest, err := routing.LoadManifest("data/routing/source-manifest.json")
	if err != nil {
		log.Fatal(err)
	}
	client, err := routing.NewClient(*upstream, manifest.RoutingDataVersion, nil)
	if err != nil {
		log.Fatal(err)
	}
	// Approximate probe coordinates, not verified museum entrances or recommended visits.
	points := []routing.Position{{44.0059, 56.3269}, {44.0095, 56.3286}, {44.0213, 56.3283}, {44.0430, 56.3220}, {43.9925, 56.3217}}
	speed := 3.5 // Explicit test assumption, not an age-derived walking norm.
	type row struct {
		From   routing.Position `json:"from"`
		To     routing.Position `json:"to"`
		Result routing.Result   `json:"result"`
	}
	report := struct {
		GeneratedAt string           `json:"generated_at"`
		Source      routing.Manifest `json:"source"`
		Probes      []row            `json:"probes"`
	}{time.Now().UTC().Format(time.RFC3339), manifest, []row{}}
	for i := 0; i < len(points); i++ {
		for _, mode := range []string{"walk", "car"} {
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			request := routing.Request{From: routing.Point{Coordinates: points[i]}, To: routing.Point{Coordinates: points[(i+1)%len(points)]}, Mode: mode}
			if mode == "walk" {
				request.WalkingSpeedKPH = &speed
			}
			result, err := client.Route(ctx, request)
			cancel()
			if err != nil {
				log.Fatalf("probe %d %s: %v", i, mode, err)
			}
			report.Probes = append(report.Probes, row{points[i], points[(i+1)%len(points)], result})
			fmt.Printf("%d %s: %.0f m, %.0f sec, %d geometry points\n", i+1, mode, result.DistanceM, result.TravelDurationSec, len(result.Geometry.Coordinates))
		}
	}
	raw, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		log.Fatal(err)
	}
	if err := os.WriteFile(*output, append(raw, '\n'), 0644); err != nil {
		log.Fatal(err)
	}
	fmt.Println("Report:", *output)
}
