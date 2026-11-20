package catalog

import (
	"strings"
	"testing"
)

func TestParsePoint(t *testing.T) {
	lon, lat, err := ParsePoint("POINT (44.003277 56.331576)")
	if err != nil || lon != 44.003277 || lat != 56.331576 {
		t.Fatalf("got %v %v %v", lon, lat, err)
	}
	for _, bad := range []string{"", "POINT EMPTY", "POINT (44.0)", "POINT (200 56)", "POINT (44 95)", "LINESTRING (1 2, 3 4)"} {
		if _, _, err := ParsePoint(bad); err == nil {
			t.Errorf("%q: ожидалась ошибка", bad)
		}
	}
}

const header = `"id","address","coordinate","description","title","category"` + "\n"

func TestParseCSV(t *testing.T) {
	data := "\ufeff" + header +
		`"1","Нижний Новгород, ул. Тестовая","POINT (44.0 56.3)","<p>Первая строка` + "\n" + `вторая строка</p>","Памятник","Памятники"` + "\n"
	rows, err := ParseCSV(strings.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].ID != "1" || rows[0].Lon != 44.0 || rows[0].Lat != 56.3 {
		t.Fatalf("неожиданный результат: %+v", rows)
	}
	if !strings.Contains(rows[0].Description, "\n") || rows[0].Raw["title"] != "Памятник" {
		t.Fatalf("многострочное описание или raw потеряны: %+v", rows[0])
	}
}

func TestParseCSVErrors(t *testing.T) {
	row := func(id, coord, category string) string {
		return `"` + id + `","адрес","` + coord + `","описание","название","` + category + `"` + "\n"
	}
	cases := map[string]string{
		"дубль id":            header + row("1", "POINT (44 56)", "Памятники") + row("1", "POINT (44 56)", "Памятники"),
		"пустая координата":   header + row("1", "", "Памятники"),
		"пустая категория":    header + row("1", "POINT (44 56)", ""),
		"нет колонки":         `"id","title"` + "\n" + `"1","x"` + "\n",
		"нет данных":          header,
		"неверная координата": header + row("1", "POINT (abc def)", "Памятники"),
	}
	for name, data := range cases {
		if _, err := ParseCSV(strings.NewReader(data)); err == nil {
			t.Errorf("%s: ожидалась ошибка", name)
		}
	}
}

func TestVisitDefaultsFor(t *testing.T) {
	d := VisitDefaultsFor("Памятники")
	if d.Mode == nil || *d.Mode != "outdoor" || d.OpenAccess == nil || !*d.OpenAccess || *d.TicketRequired {
		t.Errorf("памятники: %+v", d)
	}
	d = VisitDefaultsFor("Музеи и выставочные центры")
	if d.Mode == nil || *d.Mode != "indoor" || d.TicketRequired == nil || !*d.TicketRequired || *d.OutsideOnlyOK {
		t.Errorf("музеи: %+v", d)
	}
	d = VisitDefaultsFor("Парки и места отдыха")
	if d.Mode == nil || *d.Mode != "outdoor" || d.OpenAccess != nil {
		t.Errorf("парки: %+v", d)
	}
	for _, c := range []string{"Достопримечательности", "Культурно-развлекательные организации", "Неизвестная"} {
		if d := VisitDefaultsFor(c); d.Mode != nil || d.OutsideOnlyOK != nil || d.OpenAccess != nil || d.TicketRequired != nil {
			t.Errorf("%s: должно быть неизвестно, получено %+v", c, d)
		}
	}
}

func TestParseImages(t *testing.T) {
	sha := strings.Repeat("ab", 32)
	head := `item_id,title,category,sha256,width,height,source_url` + "\n"
	images, err := ParseImages(strings.NewReader(head + "57,Памятник Петру 1,Памятники," + sha + ",1200,800,https://example.org/a.jpg\n"))
	if err != nil {
		t.Fatal(err)
	}
	if len(images) != 1 || images[0].ItemID != "57" || len(images[0].SHA256) != 32 || images[0].Width != 1200 || images[0].Height != 800 {
		t.Fatalf("неожиданный результат: %+v", images)
	}
	for name, bad := range map[string]string{
		"короткий sha": "1,a,b,abcd,10,10,u\n",
		"ширина":       "1,a,b," + sha + ",0,10,u\n",
		"повтор":       "1,a,b," + sha + ",10,10,u\n1,a,b," + sha + ",10,10,u\n",
		"пусто":        "",
	} {
		if _, err := ParseImages(strings.NewReader(head + bad)); err == nil {
			t.Errorf("%s: ожидалась ошибка", name)
		}
	}
	if _, err := ParseImages(strings.NewReader("item_id,title\n")); err == nil {
		t.Error("без обязательных колонок ожидалась ошибка")
	}
}
