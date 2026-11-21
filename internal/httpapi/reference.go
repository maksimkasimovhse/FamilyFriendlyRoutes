package httpapi

import (
	c "github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/contracts"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/planner"
	"time"
)

func referenceData(p planner.Planner, assistant bool) map[string]any {
	interests := []map[string]string{}
	for _, pair := range [][2]string{{"animals", "Животные"}, {"plants", "Растения"}, {"nature", "Природа"}, {"space", "Космос"},
		{"science", "Наука"}, {"technology", "Техника"}, {"transport", "Транспорт"}, {"history", "История"}, {"architecture", "Архитектура"},
		{"art", "Искусство"}, {"music", "Музыка"}, {"theatre", "Театр"}, {"literature", "Литература"}, {"crafts", "Творчество и ремёсла"},
		{"cooking", "Кулинария"}, {"sport", "Спорт"}, {"play", "Игры"}, {"walks", "Прогулки"}, {"local_food", "Местная кухня"}} {
		interests = append(interests, map[string]string{"id": pair[0], "label": pair[1]})
	}
	categories := []map[string]string{}
	for _, pair := range [][2]string{{"museum", "Музеи"}, {"event", "Мероприятия"}, {"park", "Парки"}, {"playground", "Детские площадки"},
		{"restaurant", "Кафе и рестораны"}, {"toilet", "Туалеты"}, {"bench", "Места отдыха"}, {"shelter", "Укрытия"}, {"landmark", "Достопримечательности"}, {"other", "Другие места"}} {
		categories = append(categories, map[string]string{"id": pair[0], "label": pair[1]})
	}
	recsys := p.Source != nil && (p.Source.CatalogVersion() == "city-enriched-v3" || p.Source.CatalogVersion() == "city-osm-v2")
	return map[string]any{"interest_options": interests, "categories": categories, "supported_city_ids": []string{"nizhny_novgorod"},
		"supported_child_age": map[string]int{"min": 3, "max": 11}, "capabilities": map[string]bool{
			"taxi_suggestions": false, "weather_automation": false, "free_text": p.Source != nil, "assistant": assistant, "llm_understanding": p.Interpreter != nil,
			"recommendations": recsys, "needs": recsys, "fixed_sessions": recsys && p.Source.CatalogVersion() == "city-enriched-v3"},
		"default_family_policy": planner.NewDraft("", c.TripInput{}, time.Time{}).Policy, "demo_activities": p.Activities, "implementation_stage": "recsys_connected"}
}
