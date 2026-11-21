// Package wishes подбирает карточки мест по свободному пожеланию семьи («ИИ-чат»).
//
// Цепочка из docs/microservices.md: текст → parser-service (LLM, GigaChat) → ParsedRequest
// → model-service (ранжирование). Если сервис недоступен (например, нет ключа GigaChat),
// шаг заменяется локальным: ключевые основы слов (data/wish_keywords.json) и тот же прозрачный
// подсчёт совпадения тегов, что в models/query_match.py. Ответ всегда говорит, чем воспользовались.
package wishes

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

// Claim — одно явно выраженное предпочтение (формат ParsedRequest из models/request_schema.py).
type Claim struct {
	Kind     string `json:"kind"`     // interest | category | format
	Value    string `json:"value"`    // значение таксономии
	Polarity string `json:"polarity"` // prefer | avoid
	Evidence string `json:"evidence"`
}

func (c Claim) Tag() string { return c.Kind + ":" + c.Value }

type Parsed struct {
	Claims                []Claim
	NeedsClarification    bool
	ClarificationQuestion string
	Unsupported           []string
}

type Rule struct {
	Label string   `json:"label"`
	Stems []string `json:"stems"`
}

type Keywords struct {
	Rules     map[string]Rule `json:"rules"`
	AvoidCues []string        `json:"avoid_cues"`
}

func LoadKeywords(path string) (Keywords, error) {
	var k Keywords
	raw, err := os.ReadFile(path)
	if err != nil {
		return k, err
	}
	return k, json.Unmarshal(raw, &k)
}

func LoadCardTags(path string) (map[string][]string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	tags := map[string][]string{}
	return tags, json.Unmarshal(raw, &tags)
}

// Label — человеческое название тега для ответа («interest:history» → «история»).
func (k Keywords) Label(tag string) string {
	if r, ok := k.Rules[tag]; ok && r.Label != "" {
		return r.Label
	}
	return tag
}

// ParseKeywords — локальный разбор по ключевым основам. Основа, перед которой в той же фразе стоит
// «без», «не хотим», «кроме» и т. п., даёт avoid; иначе prefer.
func (k Keywords) ParseKeywords(text string) Parsed {
	lower := strings.ToLower(text)
	type seen struct {
		prefer, avoid bool
		ev            string
	}
	found := map[string]*seen{}
	for tag, rule := range k.Rules {
		for _, stem := range rule.Stems {
			stem = strings.ToLower(stem)
			from := 0
			for {
				i := strings.Index(lower[from:], stem)
				if i < 0 {
					break
				}
				i += from
				from = i + len(stem)
				// слово должно начинаться с основы, а не содержать её в середине («ока » ≠ «широкая»)
				if i > 0 {
					if prev, _ := utf8.DecodeLastRuneInString(lower[:i]); isLetter(prev) {
						continue
					}
				}
				s := found[tag]
				if s == nil {
					s = &seen{}
					found[tag] = s
				}
				if s.ev == "" {
					s.ev = evidence(text, i, len(stem))
				}
				if k.negated(lower, i) {
					s.avoid = true
				} else {
					s.prefer = true
				}
			}
		}
	}
	var p Parsed
	for tag, s := range found {
		kind, value, _ := strings.Cut(tag, ":")
		pol := "prefer"
		if s.avoid && !s.prefer {
			pol = "avoid"
		}
		p.Claims = append(p.Claims, Claim{Kind: kind, Value: value, Polarity: pol, Evidence: s.ev})
	}
	sort.Slice(p.Claims, func(i, j int) bool { return p.Claims[i].Tag() < p.Claims[j].Tag() })
	if len(p.Claims) == 0 {
		p.NeedsClarification = true
		p.ClarificationQuestion = "Расскажите, что вам интересно: например, история, парки, театры, архитектура или что-то для детей?"
	}
	return p
}

func isLetter(r rune) bool {
	return r >= 'a' && r <= 'z' || r >= 'а' && r <= 'я' || r == 'ё' || r >= '0' && r <= '9'
}

// negated: в этой же фразе (после последнего знака препинания) раньше стоит отрицание.
func (k Keywords) negated(lower string, at int) bool {
	head := lower[:at]
	if cut := strings.LastIndexAny(head, ",.;!?\n"); cut >= 0 {
		head = head[cut+1:]
	}
	if r := []rune(head); len(r) > 60 {
		head = string(r[len(r)-60:])
	}
	head = " " + head
	for _, cue := range k.AvoidCues {
		if strings.Contains(head, " "+cue) {
			return true
		}
	}
	return false
}

func evidence(text string, at, n int) string {
	r := []rune(text)
	start := utf8.RuneCountInString(text[:at])
	end := start + utf8.RuneCountInString(text[at:at+n])
	for end < len(r) && isLetter([]rune(strings.ToLower(string(r[end])))[0]) {
		end++
	}
	lo, hi := start, end
	if lo > 12 {
		lo -= 12
	} else {
		lo = 0
	}
	if hi+8 < len(r) {
		hi += 8
	} else {
		hi = len(r)
	}
	s := strings.TrimSpace(string(r[lo:hi]))
	if s == "" {
		return strings.TrimSpace(string(r[start:end]))
	}
	return s
}

// ---------- Ранжирование ----------

type Candidate struct {
	ID   string
	Tags map[string]bool
}

type Scored struct {
	ID    string   `json:"id"`
	Score float64  `json:"score"`
	Why   []string `json:"why,omitempty"`
}

// MatchScore — как query_match_score в models/query_match.py: доля нужных тегов × отсутствие нежелательных.
func MatchScore(claims []Claim, tags map[string]bool) float64 {
	var prefer, avoid []string
	for _, c := range claims {
		if c.Polarity == "avoid" {
			avoid = append(avoid, c.Tag())
		} else {
			prefer = append(prefer, c.Tag())
		}
	}
	if len(prefer) == 0 && len(avoid) == 0 {
		return 0.5
	}
	cov := 1.0
	if len(prefer) > 0 {
		n := 0
		for _, t := range prefer {
			if tags[t] {
				n++
			}
		}
		cov = float64(n) / float64(len(prefer))
	}
	avoided := 0.0
	if len(avoid) > 0 {
		n := 0
		for _, t := range avoid {
			if tags[t] {
				n++
			}
		}
		avoided = float64(n) / float64(len(avoid))
	}
	return cov * (1 - avoided)
}

// childScore — доля интересов ребёнка из анкеты, которые есть у места (мягкий сигнал).
func childScore(interests []string, tags map[string]bool) float64 {
	if len(interests) == 0 {
		return 0
	}
	n := 0
	for _, i := range interests {
		if tags["interest:"+i] {
			n++
		}
	}
	return float64(n) / float64(len(interests))
}

// ---------- Внешние сервисы ----------

type Services struct {
	ParserURL string // http://parser-service:8080 (пусто — только локальный разбор)
	ModelURL  string // http://model-service:8080 (пусто — только локальное ранжирование)
	Client    *http.Client
}

func (s Services) client() *http.Client {
	if s.Client != nil {
		return s.Client
	}
	return &http.Client{Timeout: 25 * time.Second}
}

func (s Services) post(ctx context.Context, url string, in, out any) error {
	body, _ := json.Marshal(in)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := s.client().Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("%s: %s", url, res.Status)
	}
	return json.NewDecoder(io.LimitReader(res.Body, 4<<20)).Decode(out)
}

// parseLLM — parser-service: текст → закрытые claims (GigaChat). Ошибка означает «используй локальный разбор».
func (s Services) parseLLM(ctx context.Context, id, text string) (Parsed, error) {
	var out struct {
		Parsed struct {
			Claims                []Claim  `json:"claims"`
			NeedsClarification    bool     `json:"needs_clarification"`
			ClarificationQuestion *string  `json:"clarification_question"`
			Unsupported           []string `json:"unsupported_requests"`
		} `json:"parsed_request"`
	}
	in := map[string]any{"contract_version": "1.0", "request_id": id, "text": text}
	if err := s.post(ctx, strings.TrimRight(s.ParserURL, "/")+"/internal/v1/request-parses", in, &out); err != nil {
		return Parsed{}, err
	}
	p := Parsed{Claims: out.Parsed.Claims, NeedsClarification: out.Parsed.NeedsClarification, Unsupported: out.Parsed.Unsupported}
	if out.Parsed.ClarificationQuestion != nil {
		p.ClarificationQuestion = *out.Parsed.ClarificationQuestion
	}
	return p, nil
}

// rankModel — model-service: прозрачный baseline-ранкер (models/place_ranker.py). Возвращает id → оценку.
func (s Services) rankModel(ctx context.Context, id string, p Parsed, cands []Candidate, interests []string) (map[string]float64, error) {
	items := make([]map[string]any, 0, len(cands))
	for _, c := range cands {
		tags := make([]string, 0, len(c.Tags))
		for t := range c.Tags {
			tags = append(tags, t)
		}
		sort.Strings(tags)
		items = append(items, map[string]any{
			"activity_id":    c.ID,
			"eligibility":    map[string]string{"child-1": "eligible"},
			"child_interest": map[string]float64{"child-1": childScore(interests, c.Tags) * 2},
			"child_age_fit":  map[string]any{"child-1": nil},
			"adult_interest": 0.5,
			"popularity":     0.5,
			"tags":           tags,
		})
	}
	claims := p.Claims
	if claims == nil {
		claims = []Claim{}
	}
	in := map[string]any{
		"contract_version": "1.0", "request_id": id, "limit": 100, "candidates": items,
		"parsed_request": map[string]any{
			"taxonomy_version": "1.0", "claims": claims, "needs_clarification": false,
			"clarification_question": nil, "unsupported_requests": []string{},
		},
	}
	var out struct {
		Ranked []struct {
			ID    string  `json:"activity_id"`
			Score float64 `json:"final_relevance"`
		} `json:"ranked"`
	}
	if err := s.post(ctx, strings.TrimRight(s.ModelURL, "/")+"/internal/v1/rankings", in, &out); err != nil {
		return nil, err
	}
	scores := map[string]float64{}
	for _, r := range out.Ranked {
		scores[r.ID] = r.Score
	}
	return scores, nil
}

// ---------- Подбор ----------

type Request struct {
	Text      string   `json:"text"`
	Interests []string `json:"interests"` // интересы ребёнка из анкеты (id таксономии)
}

type ClaimView struct {
	Kind     string `json:"kind"`
	Value    string `json:"value"`
	Polarity string `json:"polarity"`
	Label    string `json:"label"`
}

type Result struct {
	Reply         string      `json:"reply"`
	Parser        string      `json:"parser"` // gigachat | keywords
	Ranker        string      `json:"ranker"` // model-service | local
	Claims        []ClaimView `json:"claims"`
	Ranked        []Scored    `json:"ranked"`
	Matched       int         `json:"matched"`  // сколько мест подошли по пожеланию
	Excluded      int         `json:"excluded"` // сколько убрали из-за «без …»
	Missing       []string    `json:"missing"`  // что просили, но таких мест в списке нет
	Clarification string      `json:"clarification,omitempty"`
}

const (
	MaxDeck = 60 // сколько карточек отдаём в подбор
	MinDeck = 12 // если подошло меньше — добираем ближайшими по оценке
)

type Recommender struct {
	Keywords Keywords
	Cards    []Candidate
	Services Services
}

func NewRecommender(k Keywords, tags map[string][]string, s Services) *Recommender {
	ids := make([]string, 0, len(tags))
	for id := range tags {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	r := &Recommender{Keywords: k, Services: s}
	for _, id := range ids {
		set := map[string]bool{}
		for _, t := range tags[id] {
			set[t] = true
		}
		r.Cards = append(r.Cards, Candidate{ID: id, Tags: set})
	}
	return r
}

func (r *Recommender) Recommend(ctx context.Context, reqID string, in Request) Result {
	res := Result{Parser: "keywords", Ranker: "local", Claims: []ClaimView{}, Ranked: []Scored{}, Missing: []string{}}
	text := strings.TrimSpace(in.Text)

	var parsed Parsed
	got := false
	if r.Services.ParserURL != "" {
		if p, err := r.Services.parseLLM(ctx, reqID, text); err == nil && p.valid() {
			parsed, res.Parser, got = p, "gigachat", true
		}
	}
	if !got {
		parsed = r.Keywords.ParseKeywords(text)
	}
	for _, c := range parsed.Claims {
		res.Claims = append(res.Claims, ClaimView{c.Kind, c.Value, c.Polarity, r.Keywords.Label(c.Tag())})
	}

	// Нежелательное («без музеев») убираем, нужное ищем по тегам
	var prefer, avoid []Claim
	for _, c := range parsed.Claims {
		if c.Polarity == "avoid" {
			avoid = append(avoid, c)
		} else {
			prefer = append(prefer, c)
		}
	}
	var pool []Candidate
	for _, c := range r.Cards {
		bad := false
		for _, a := range avoid {
			if c.Tags[a.Tag()] {
				bad = true
			}
		}
		if bad {
			res.Excluded++
		} else {
			pool = append(pool, c)
		}
	}

	scores := map[string]float64{}
	if r.Services.ModelURL != "" {
		if m, err := r.Services.rankModel(ctx, reqID, parsed, pool, in.Interests); err == nil && len(m) > 0 {
			scores, res.Ranker = m, "model-service"
		}
	}
	if res.Ranker == "local" {
		for _, c := range pool {
			scores[c.ID] = 0.75*MatchScore(parsed.Claims, c.Tags) + 0.25*childScore(in.Interests, c.Tags)
		}
	}

	type row struct {
		Candidate
		score float64
		match float64
	}
	rows := make([]row, 0, len(pool))
	for _, c := range pool {
		rows = append(rows, row{c, scores[c.ID], MatchScore(parsed.Claims, c.Tags)})
	}
	sort.SliceStable(rows, func(i, j int) bool {
		if rows[i].score != rows[j].score {
			return rows[i].score > rows[j].score
		}
		return rows[i].ID < rows[j].ID
	})

	// Совпало хоть что-то нужное — столько и берём; не нашлось — берём лучшие по оценке
	hasPrefer := len(prefer) > 0
	for _, x := range rows {
		if hasPrefer && x.match > 0 || !hasPrefer && len(avoid) > 0 {
			res.Matched++
		}
	}
	for _, x := range rows {
		hit := !hasPrefer || x.match > 0
		if len(res.Ranked) >= MaxDeck {
			break
		}
		if !hit && len(res.Ranked) >= MinDeck {
			break
		}
		var why []string
		for _, p := range prefer {
			if x.Tags[p.Tag()] {
				why = append(why, r.Keywords.Label(p.Tag()))
			}
		}
		res.Ranked = append(res.Ranked, Scored{ID: x.ID, Score: round(x.score), Why: why})
	}

	for _, p := range prefer {
		n := 0
		for _, c := range pool {
			if c.Tags[p.Tag()] {
				n++
			}
		}
		if n == 0 {
			res.Missing = append(res.Missing, r.Keywords.Label(p.Tag()))
		}
	}
	if parsed.NeedsClarification {
		res.Clarification = parsed.ClarificationQuestion
	}
	res.Reply = r.reply(res, parsed, hasPrefer)
	return res
}

func (p Parsed) valid() bool { return len(p.Claims) > 0 || p.NeedsClarification }

func round(v float64) float64 { return float64(int(v*1000+0.5)) / 1000 }

func (r *Recommender) reply(res Result, p Parsed, hasPrefer bool) string {
	var want, not []string
	for _, c := range res.Claims {
		if c.Polarity == "avoid" {
			not = append(not, c.Label)
		} else {
			want = append(want, c.Label)
		}
	}
	if len(want) == 0 && len(not) == 0 {
		if p.ClarificationQuestion != "" {
			return "Пока не поняла, что вам хочется. " + p.ClarificationQuestion
		}
		return "Не нашла в сообщении пожеланий. Напишите, что вам интересно."
	}
	var b strings.Builder
	b.WriteString("Поняла: ")
	if len(want) > 0 {
		b.WriteString("хотите — " + strings.Join(want, ", "))
	}
	if len(not) > 0 {
		if len(want) > 0 {
			b.WriteString("; ")
		}
		b.WriteString("не нужно — " + strings.Join(not, ", "))
	}
	b.WriteString(". ")
	switch {
	case hasPrefer && res.Matched == 0:
		b.WriteString("Точных совпадений в нашем списке нет, покажу самые близкие.")
	case hasPrefer && res.Matched > len(res.Ranked):
		fmt.Fprintf(&b, "Подошло мест: %d, покажу лучшие %d.", res.Matched, len(res.Ranked))
	case hasPrefer:
		fmt.Fprintf(&b, "Подобрала мест: %d.", res.Matched)
	default:
		fmt.Fprintf(&b, "Убрала лишнее, осталось мест: %d.", len(res.Ranked))
	}
	if len(res.Missing) > 0 {
		b.WriteString(" Из просьбы «" + strings.Join(res.Missing, "», «") + "» в нашем списке мест нет.")
	}
	return b.String()
}
