package catalog

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// Load загружает набор в одной транзакции. Повторный запуск идемпотентен:
// записи находятся по (source_dataset, source_id). Поля, которые правят вручную
// (show_in_cards, show_on_map, is_published, размеченный place_details),
// при повторной загрузке не перезаписываются.
func Load(ctx context.Context, tx pgx.Tx, ds Dataset, rows []Row, sourceFile, catalogVersion string) error {
	if _, err := tx.Exec(ctx,
		`INSERT INTO catalog_versions (version, note) VALUES ($1, 'загружено dbload')
		 ON CONFLICT (version) DO NOTHING`, catalogVersion); err != nil {
		return fmt.Errorf("версия каталога: %w", err)
	}
	categories, err := loadCategories(ctx, tx, ds.ItemType)
	if err != nil {
		return err
	}
	for _, row := range rows {
		categoryID, ok := categories[row.Category]
		if !ok {
			return fmt.Errorf("%s id=%s: неизвестная категория %q для типа %s", ds.Name, row.ID, row.Category, ds.ItemType)
		}
		var itemID int32
		if err := tx.QueryRow(ctx, `
			INSERT INTO items (item_type, category_id, show_in_cards, title, source_dataset, source_id, catalog_version)
			VALUES ($1::item_type, $2, $3, $4, $5, $6, $7)
			ON CONFLICT (source_dataset, source_id) DO UPDATE
			   SET item_type = EXCLUDED.item_type, category_id = EXCLUDED.category_id,
			       title = EXCLUDED.title, catalog_version = EXCLUDED.catalog_version, updated_at = now()
			RETURNING item_id`,
			ds.ItemType, categoryID, ds.ShowInCards, row.Title, ds.Name, row.ID, catalogVersion,
		).Scan(&itemID); err != nil {
			return fmt.Errorf("%s id=%s: items: %w", ds.Name, row.ID, err)
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO item_content (item_id, description_html) VALUES ($1, $2)
			ON CONFLICT (item_id) DO UPDATE SET description_html = EXCLUDED.description_html`,
			itemID, row.Description); err != nil {
			return fmt.Errorf("%s id=%s: item_content: %w", ds.Name, row.ID, err)
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO item_location (item_id, location, address)
			VALUES ($1, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, $4)
			ON CONFLICT (item_id) DO UPDATE SET location = EXCLUDED.location, address = EXCLUDED.address`,
			itemID, row.Lon, row.Lat, row.Address); err != nil {
			return fmt.Errorf("%s id=%s: item_location: %w", ds.Name, row.ID, err)
		}
		raw, err := json.Marshal(row.Raw)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO item_raw (item_id, raw, source_file) VALUES ($1, $2::jsonb, $3)
			ON CONFLICT (item_id) DO UPDATE SET raw = EXCLUDED.raw, source_file = EXCLUDED.source_file, loaded_at = now()`,
			itemID, string(raw), sourceFile); err != nil {
			return fmt.Errorf("%s id=%s: item_raw: %w", ds.Name, row.ID, err)
		}
		if ds.PlaceDetails {
			d := VisitDefaultsFor(row.Category)
			if _, err := tx.Exec(ctx, `
				INSERT INTO place_details (item_id, visit_mode, outside_only_ok, open_access, ticket_required)
				VALUES ($1, $2, $3, $4, $5)
				ON CONFLICT (item_id) DO NOTHING`,
				itemID, d.Mode, d.OutsideOnlyOK, d.OpenAccess, d.TicketRequired); err != nil {
				return fmt.Errorf("%s id=%s: place_details: %w", ds.Name, row.ID, err)
			}
		}
	}
	return nil
}

func loadCategories(ctx context.Context, tx pgx.Tx, itemType string) (map[string]int16, error) {
	rows, err := tx.Query(ctx, `SELECT name_ru, category_id FROM categories WHERE item_type = $1::item_type`, itemType)
	if err != nil {
		return nil, fmt.Errorf("категории: %w", err)
	}
	defer rows.Close()
	result := map[string]int16{}
	for rows.Next() {
		var name string
		var id int16
		if err := rows.Scan(&name, &id); err != nil {
			return nil, err
		}
		result[name] = id
	}
	return result, rows.Err()
}
