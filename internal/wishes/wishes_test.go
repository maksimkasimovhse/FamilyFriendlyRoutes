package wishes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func kw(t *testing.T) Keywords {
	t.Helper()
	k, err := LoadKeywords("../../data/wish_keywords.json")
	if err != nil {
		t.Fatal(err)
	}
	return k
}

func claimsOf(p Parsed) map[string]string {
	m := map[string]string{}
	for _, c := range p.Claims {
		m[c.Tag()] = c.Polarity
	}
	return m
}

func TestParseKeywordsPreferAndAvoid(t *testing.T) {
	p := kw(t).ParseKeywords("Хотим про историю и театры, но без музеев")
	got := claimsOf(p)
	if got["interest:history"] != "prefer" || got["interest:theatre"] != "prefer" {
		t.Fatalf("prefer: %v", got)
	}
	if got["category:museum"] != "avoid" {
		t.Fatalf("avoid museum: %v", got)
	}
}

func TestParseKeywordsNegationStaysInPhrase(t *testing.T) {
	got := claimsOf(kw(t).ParseKeywords("Не хотим музеи, любим парки"))
	if got["category:museum"] != "avoid" || got["category:park"] != "prefer" {
		t.Fatalf("%v", got)
	}
}

func TestParseKeywordsNeedsClarification(t *testing.T) {
	p := kw(t).ParseKeywords("привет")
	if !p.NeedsClarification || p.ClarificationQuestion == "" || len(p.Claims) != 0 {
		t.Fatalf("%+v", p)
	}
}

func TestWordStartOnly(t *testing.T) {
	// «ока » не должно срабатывать внутри слова «широкая»
	if _, ok := claimsOf(kw(t).ParseKeywords("широкая улица"))["interest:nature"]; ok {
		t.Fatal("основа найдена в середине слова")
	}
}

func recommender(t *testing.T, s Services) *Recommender {
	tags := map[string][]string{
		"1": {"category:museum", "interest:history"},
		"2": {"category:park", "interest:nature", "format:calm"},
		"3": {"category:event", "interest:theatre"},
		"4": {"category:landmark", "interest:history", "interest:architecture"},
	}
	return NewRecommender(kw(t), tags, s)
}

func TestRecommendLocalFiltersAndExcludes(t *testing.T) {
	res := recommender(t, Services{}).Recommend(context.Background(), "t", Request{Text: "история, но без музеев"})
	if res.Parser != "keywords" || res.Ranker != "local" {
		t.Fatalf("%s/%s", res.Parser, res.Ranker)
	}
	if res.Excluded != 1 {
		t.Fatalf("excluded=%d", res.Excluded)
	}
	for _, r := range res.Ranked {
		if r.ID == "1" {
			t.Fatal("музей должен быть исключён")
		}
	}
	if len(res.Ranked) == 0 || res.Ranked[0].ID != "4" {
		t.Fatalf("первым ожидался id 4: %+v", res.Ranked)
	}
	if !strings.Contains(res.Reply, "Поняла") {
		t.Fatal(res.Reply)
	}
}

func TestRecommendMissingTopic(t *testing.T) {
	res := recommender(t, Services{}).Recommend(context.Background(), "t", Request{Text: "хотим космос"})
	if len(res.Missing) != 1 || res.Matched != 0 || len(res.Ranked) == 0 {
		t.Fatalf("%+v", res)
	}
}

func TestRecommendUsesParserAndModelServices(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/internal/v1/request-parses", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"parsed_request": map[string]any{
			"claims":               []map[string]string{{"kind": "interest", "value": "theatre", "polarity": "prefer", "evidence": "театр"}},
			"needs_clarification":  false,
			"unsupported_requests": []string{},
		}})
	})
	mux.HandleFunc("/internal/v1/rankings", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"ranked": []map[string]any{{"activity_id": "3", "final_relevance": 0.9}, {"activity_id": "2", "final_relevance": 0.1}}})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	res := recommender(t, Services{ParserURL: srv.URL, ModelURL: srv.URL}).Recommend(context.Background(), "t", Request{Text: "что-нибудь для души"})
	if res.Parser != "gigachat" || res.Ranker != "model-service" {
		t.Fatalf("%s/%s", res.Parser, res.Ranker)
	}
	if res.Ranked[0].ID != "3" {
		t.Fatalf("%+v", res.Ranked)
	}
}

func TestFallsBackWhenServicesFail(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Error(w, "boom", 500) }))
	defer srv.Close()
	res := recommender(t, Services{ParserURL: srv.URL, ModelURL: srv.URL}).Recommend(context.Background(), "t", Request{Text: "хотим парки"})
	if res.Parser != "keywords" || res.Ranker != "local" || res.Ranked[0].ID != "2" {
		t.Fatalf("%+v", res)
	}
}
