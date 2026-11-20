// dbload загружает наборы main.csv и addition.csv в PostgreSQL.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"

	"github.com/jackc/pgx/v5"

	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/catalog"
)

func main() {
	url := flag.String("database-url", os.Getenv("DATABASE_URL"), "Строка подключения PostgreSQL (по умолчанию $DATABASE_URL)")
	seedDir := flag.String("seed-dir", "db/seed", "Каталог с CSV")
	version := flag.String("catalog-version", "2026-11-20", "Версия каталога, записывается в items.catalog_version")
	flag.Parse()
	if *url == "" {
		log.Fatal("не задана строка подключения: используйте -database-url или DATABASE_URL")
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, *url)
	if err != nil {
		log.Fatal(err)
	}
	defer conn.Close(ctx)
	for _, ds := range catalog.Datasets {
		path := filepath.Join(*seedDir, ds.File)
		file, err := os.Open(path)
		if err != nil {
			log.Fatal(err)
		}
		rows, err := catalog.ParseCSV(file)
		file.Close()
		if err != nil {
			log.Fatalf("%s: %v", path, err)
		}
		tx, err := conn.Begin(ctx)
		if err != nil {
			log.Fatal(err)
		}
		if err := catalog.Load(ctx, tx, ds, rows, ds.File, *version); err != nil {
			_ = tx.Rollback(ctx)
			log.Fatalf("%s: %v", path, err)
		}
		if err := tx.Commit(ctx); err != nil {
			log.Fatal(err)
		}
		fmt.Printf("%s: загружено %d записей\n", ds.Name, len(rows))
	}
	loadImages(ctx, conn, filepath.Join(*seedDir, "card_images.csv"))
}

// loadImages записывает обложки карточек (набор main) из card_images.csv.
func loadImages(ctx context.Context, conn *pgx.Conn, path string) {
	file, err := os.Open(path)
	if err != nil {
		log.Fatal(err)
	}
	images, err := catalog.ParseImages(file)
	file.Close()
	if err != nil {
		log.Fatalf("%s: %v", path, err)
	}
	tx, err := conn.Begin(ctx)
	if err != nil {
		log.Fatal(err)
	}
	if err := catalog.LoadImages(ctx, tx, "main", images); err != nil {
		_ = tx.Rollback(ctx)
		log.Fatalf("%s: %v", path, err)
	}
	if err := tx.Commit(ctx); err != nil {
		log.Fatal(err)
	}
	fmt.Printf("картинки: загружено %d обложек\n", len(images))
}
