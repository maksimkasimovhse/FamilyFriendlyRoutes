package catalog

import (
	"bytes"
	"context"
	"encoding/csv"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
)

// Image — обложка карточки: запись card_images.csv. Файлы лежат в assets/images
// по пути ab/cd/<sha256>_{thumb,card,full}.webp (его строит scripts/build-card-images.py).
type Image struct {
	ItemID        string // id в main.csv (items.source_id)
	Title         string
	SHA256        []byte
	Width, Height int
	SourceURL     string
}

var imageColumns = []string{"item_id", "title", "sha256", "width", "height", "source_url"}

// ParseImages читает card_images.csv. Как и ParseCSV, останавливается на первой ошибке.
func ParseImages(r io.Reader) ([]Image, error) {
	raw, err := io.ReadAll(r)
	if err != nil {
		return nil, err
	}
	reader := csv.NewReader(bytes.NewReader(bytes.TrimPrefix(raw, []byte{0xEF, 0xBB, 0xBF})))
	reader.FieldsPerRecord = -1
	header, err := reader.Read()
	if err != nil {
		return nil, fmt.Errorf("заголовок CSV: %w", err)
	}
	index := map[string]int{}
	for i, name := range header {
		index[strings.TrimSpace(name)] = i
	}
	for _, name := range imageColumns {
		if _, ok := index[name]; !ok {
			return nil, fmt.Errorf("в CSV нет колонки %q", name)
		}
	}
	var images []Image
	seen := map[string]bool{}
	for line := 2; ; line++ {
		record, err := reader.Read()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("запись %d: %w", line, err)
		}
		if len(record) != len(header) {
			return nil, fmt.Errorf("запись %d: %d полей, ожидалось %d", line, len(record), len(header))
		}
		get := func(name string) string { return strings.TrimSpace(record[index[name]]) }
		img := Image{ItemID: get("item_id"), Title: get("title"), SourceURL: get("source_url")}
		if img.ItemID == "" {
			return nil, fmt.Errorf("запись %d: пустой item_id", line)
		}
		if seen[img.ItemID] {
			return nil, fmt.Errorf("запись %d: повторяющийся item_id %s", line, img.ItemID)
		}
		seen[img.ItemID] = true
		if img.SHA256, err = hex.DecodeString(get("sha256")); err != nil || len(img.SHA256) != 32 {
			return nil, fmt.Errorf("запись %d (item_id=%s): sha256 должен быть 64 hex-символа", line, img.ItemID)
		}
		if img.Width, err = strconv.Atoi(get("width")); err != nil || img.Width <= 0 || img.Width > 32767 {
			return nil, fmt.Errorf("запись %d (item_id=%s): некорректная ширина %q", line, img.ItemID, get("width"))
		}
		if img.Height, err = strconv.Atoi(get("height")); err != nil || img.Height <= 0 || img.Height > 32767 {
			return nil, fmt.Errorf("запись %d (item_id=%s): некорректная высота %q", line, img.ItemID, get("height"))
		}
		images = append(images, img)
	}
	if len(images) == 0 {
		return nil, errors.New("в CSV нет данных")
	}
	return images, nil
}

// LoadImages записывает обложки в item_images. Объекты ищутся по (dataset, source_id);
// отсутствующий объект — ошибка, чтобы не терять картинки молча. Повторный запуск идемпотентен:
// если у объекта сменилась картинка, старая обложка заменяется.
func LoadImages(ctx context.Context, tx pgx.Tx, dataset string, images []Image) error {
	for _, img := range images {
		var itemID int32
		if err := tx.QueryRow(ctx,
			`SELECT item_id FROM items WHERE source_dataset = $1 AND source_id = $2`,
			dataset, img.ItemID).Scan(&itemID); err != nil {
			return fmt.Errorf("%s id=%s: объект не найден (сначала загрузите набор): %w", dataset, img.ItemID, err)
		}
		if _, err := tx.Exec(ctx,
			`DELETE FROM item_images WHERE item_id = $1 AND is_cover AND sha256 <> $2`,
			itemID, img.SHA256); err != nil {
			return fmt.Errorf("%s id=%s: замена обложки: %w", dataset, img.ItemID, err)
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO item_images (item_id, sha256, width, height, is_cover, alt_text, source_url)
			VALUES ($1, $2, $3, $4, true, $5, NULLIF($6, ''))
			ON CONFLICT (item_id, sha256) DO UPDATE
			   SET width = EXCLUDED.width, height = EXCLUDED.height, is_cover = true,
			       alt_text = EXCLUDED.alt_text, source_url = EXCLUDED.source_url`,
			itemID, img.SHA256, img.Width, img.Height, img.Title, img.SourceURL); err != nil {
			return fmt.Errorf("%s id=%s: item_images: %w", dataset, img.ItemID, err)
		}
	}
	return nil
}
