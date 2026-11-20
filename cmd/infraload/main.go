// infraload imports a versioned real OSM infrastructure snapshot into PostgreSQL.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/mapdata"
)

func main() {
	database := flag.String("database-url", os.Getenv("DATABASE_URL"), "PostgreSQL connection string")
	file := flag.String("file", "data/infrastructure/osm-infrastructure.geojson", "OSM infrastructure snapshot")
	version := flag.String("catalog-version", "", "Override snapshot version (default uses checked_at)")
	flag.Parse()
	if *database == "" {
		log.Fatal("Set DATABASE_URL")
	}
	f, err := os.Open(*file)
	if err != nil {
		log.Fatal(err)
	}
	defer f.Close()
	snapshot, err := mapdata.ParseSnapshot(f)
	if err != nil {
		log.Fatal(err)
	}
	if *version == "" {
		*version = "osm-infrastructure-" + snapshot.CheckedAt.UTC().Format("20060102T150405Z")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	conn, err := pgx.Connect(ctx, *database)
	if err != nil {
		log.Fatal("Cannot connect to PostgreSQL; check DATABASE_URL and database availability")
	}
	defer conn.Close(ctx)
	tx, err := conn.Begin(ctx)
	if err != nil {
		log.Fatal(err)
	}
	defer tx.Rollback(ctx)
	count, err := mapdata.Import(ctx, tx, snapshot, *version)
	if err != nil {
		log.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		log.Fatal(err)
	}
	fmt.Printf("Infrastructure: %d objects, version %s\n", count, *version)
}
