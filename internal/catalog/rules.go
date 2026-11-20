package catalog

// Dataset описывает, как набор превращается в записи каталога.
type Dataset struct {
	Name         string // items.source_dataset
	File         string // имя файла в каталоге seed
	ItemType     string // items.item_type
	ShowInCards  bool   // выводить как карточку
	PlaceDetails bool   // создавать place_details
}

// Datasets — наборы, которые загружает dbload, в порядке загрузки.
var Datasets = []Dataset{
	{Name: "main", File: "main.csv", ItemType: "place", ShowInCards: true, PlaceDetails: true},
	// Объекты addition подсвечиваются на карте и в карточки не выводятся.
	{Name: "addition", File: "addition.csv", ItemType: "map_object", ShowInCards: false},
}

// VisitDefaults — начальная разметка «как осматривают объект». nil-поля остаются
// неизвестными и размечаются позже (ML или вручную).
type VisitDefaults struct {
	Mode           *string
	OutsideOnlyOK  *bool
	OpenAccess     *bool
	TicketRequired *bool
}

func str(s string) *string { return &s }
func boolean(b bool) *bool { return &b }

// VisitDefaultsFor возвращает начальные значения по категории места.
// Для «Достопримечательностей» и «Культурно-развлекательных организаций»
// режим зависит от конкретного объекта, поэтому всё остаётся неизвестным.
func VisitDefaultsFor(category string) VisitDefaults {
	switch category {
	case "Памятники", "Набережные":
		return VisitDefaults{str("outdoor"), boolean(true), boolean(true), boolean(false)}
	case "Парки и места отдыха":
		return VisitDefaults{Mode: str("outdoor"), OutsideOnlyOK: boolean(true)}
	case "Музеи и выставочные центры", "Театры":
		return VisitDefaults{str("indoor"), boolean(false), boolean(false), boolean(true)}
	}
	return VisitDefaults{}
}
