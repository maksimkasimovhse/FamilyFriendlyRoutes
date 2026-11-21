package planner

import (
	"context"
	"fmt"
	c "github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/contracts"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/routing"
	"math"
	"sort"
	"time"
)

func outingDuration(day c.DayPlan) float64 {
	if day.Totals.OutingDurationSec != nil {
		return *day.Totals.OutingDurationSec
	}
	if day.Totals.ElapsedDurationSec != nil {
		return *day.Totals.ElapsedDurationSec
	}
	return 0
}
func napHomeTime(day c.DayPlan) float64 {
	total := 0.0
	for _, s := range day.Stops {
		if stopKind(s) == "nap" && s.Progress == "visited" {
			total += s.Duration.DurationSec
			if s.Timing.EstimatedArrivalAt != nil && s.Timing.EstimatedVisitStartAt != nil {
				a, _ := parseInstant(*s.Timing.EstimatedArrivalAt)
				b, _ := parseInstant(*s.Timing.EstimatedVisitStartAt)
				total += math.Max(0, b.Sub(a).Seconds())
			}
		}
	}
	return total
}
func (p Planner) buildDay(ctx context.Context, view c.TripView, now time.Time) (c.TripView, error) {
	if view.Input.Days[0].Nap == nil {
		return p.buildPlainDay(ctx, view, now)
	}
	return p.buildNapDay(ctx, view, now)
}

// The lodging anchor is outside the ML candidate pool and never consumes a card.
// Both sides use real directed OSM legs and the same opening/session checks.
func (p Planner) buildNapDay(ctx context.Context, view c.TripView, now time.Time) (c.TripView, error) {
	input := view.Input
	day := input.Days[0]
	nap := day.Nap
	sleepStart, _ := parseInstant(nap.Window.StartAt)
	sleepEnd, _ := parseInstant(nap.Window.EndAt)
	if day.AvailableWindow == nil {
		return c.TripView{}, invalid("NAP_WINDOW_REQUIRED")
	}
	input.Selections = append([]c.Selection{}, input.Selections...)
	sort.SliceStable(input.Selections, func(i, j int) bool {
		return p.napChoiceRank(input.Selections[i], day) < p.napChoiceRank(input.Selections[j], day)
	})
	earliest, _ := parseInstant(day.AvailableWindow.StartAt)
	finish, _ := parseInstant(day.AvailableWindow.EndAt)
	if !earliest.Before(sleepEnd) {
		return c.TripView{}, stateError("NAP_WINDOW_PASSED", "Время дневного сна прошло. Отключите сон для этого дня в настройках поездки.")
	}
	if _, ok := p.Router.(*routeCache); !ok {
		p.Router = &routeCache{router: p.Router, values: map[routeKey]routing.Result{}}
	}
	build := func(choices []c.Selection, from, to routing.Point, start, end time.Time) (c.DayPlan, error) {
		trial := view
		trial.Input = input
		d := day
		d.Nap = nil
		d.StartPoint = from
		d.EndPoint = to
		d.AvailableWindow = &c.Interval{StartAt: instant(start), EndAt: instant(end)}
		d.DurationBudgetSec = math.Max(0, end.Sub(start).Seconds())
		trial.Input.Days = []c.DayInput{d}
		trial.Input.Selections = choices
		trial.Input.PlanningContext = "in_city"
		r, err := p.buildPlainDay(ctx, trial, now)
		if err != nil {
			return c.DayPlan{}, err
		}
		return r.Days[0], nil
	}
	var best c.DayPlan
	bestSet := false
	bestScore := math.Inf(1)
	for split := 0; split <= len(input.Selections); split++ {
		if err := ctx.Err(); err != nil {
			return c.TripView{}, err
		}
		before, after := input.Selections[:split], input.Selections[split:]
		morning, err := build(before, day.StartPoint, nap.Location, earliest, sleepStart)
		if err != nil {
			return c.TripView{}, err
		}
		latest := earliest
		if morning.Feasibility != "infeasible" {
			lo, hi := earliest, sleepStart
			for hi.Sub(lo) > time.Minute {
				mid := lo.Add(hi.Sub(lo) / 2)
				trial, e := build(before, day.StartPoint, nap.Location, mid, sleepStart)
				if e != nil {
					return c.TripView{}, e
				}
				if trial.Feasibility != "infeasible" {
					lo = mid
				} else {
					hi = mid
				}
			}
			latest = lo.Truncate(time.Minute)
			if latest.Before(earliest) {
				latest = earliest
			}
			if input.PlanningContext == "before_arrival" {
				morning, err = build(before, day.StartPoint, nap.Location, latest, sleepStart)
				if err != nil {
					return c.TripView{}, err
				}
			}
		}
		afternoon, err := build(after, nap.Location, day.EndPoint, sleepEnd, finish)
		if err != nil {
			return c.TripView{}, err
		}
		morningStart := earliest
		if input.PlanningContext == "before_arrival" {
			morningStart = latest
		}
		arrival := morningStart.Add(time.Duration(*morning.Totals.ElapsedDurationSec * float64(time.Second)))
		homeWait := math.Max(0, sleepStart.Sub(arrival).Seconds())
		sleepSec := sleepEnd.Sub(sleepStart).Seconds()
		outing := *morning.Totals.ElapsedDurationSec + *afternoon.Totals.ElapsedDurationSec
		elapsed := outing + homeWait + sleepSec
		plan := morning
		plan.Date = day.Date
		plan.StartPoint = day.StartPoint
		plan.EndPoint = day.EndPoint
		windowCopy := *day.AvailableWindow
		windowCopy.StartAt = instant(morningStart)
		plan.AvailableWindow = &windowCopy
		plan.Presentation = "relative"
		if input.PlanningContext == "in_city" {
			plan.Presentation = "clock"
		}
		plan.Warnings = append(append([]c.Warning{}, morning.Warnings...), afternoon.Warnings...)
		if afternoon.Feasibility == "infeasible" {
			plan.Feasibility = "infeasible"
		}
		if arrival.After(sleepStart) || earliest.After(sleepStart) || sleepEnd.After(finish) {
			plan.Feasibility = "infeasible"
			plan.Warnings = append(plan.Warnings, Warning("NAP_RETURN_MISSED", "Не получается вернуться в жильё к началу дневного сна. Начните раньше или измените утренние места."))
		}
		if outing > dailyTimeBudget(day) {
			plan.Feasibility = "infeasible"
			plan.Warnings = append(plan.Warnings, Warning("DAY_BUDGET_EXCEEDED", "Посещения и все переходы превышают выбранное время прогулки. Сон учитывается отдельно."))
		}
		napID := c.ID("nap-" + string(day.Date))
		kind := "nap"
		avail := []c.AvailabilityDay{{Date: day.Date, State: "open", VisitWindows: []c.Interval{nap.Window}}}
		stop := c.Stop{StopID: napID, ActivityID: napID, PlaceID: c.ID("lodging-" + string(view.TripID)), Title: "Дневной сон в жилье", Category: "lodging", Location: nap.Location, Mandatory: true, Progress: "planned", ActivityKind: &kind, Availability: &avail, Duration: c.DurationEstimate{DurationSec: sleepSec, Source: "user", EvidenceIDS: []c.ID{}}, Reasons: []c.Reason{}, Warnings: []c.Warning{}}
		stop.BalanceCredit = nonNil(stop.BalanceCredit)
		avail[0].Occurrences = nonNil(avail[0].Occurrences)
		avail[0].EvidenceIDS = []c.ID{}
		at := instant(arrival)
		stop.Timing.EstimatedArrivalAt = &at
		startAt, endAt := nap.Window.StartAt, nap.Window.EndAt
		stop.Timing.EstimatedVisitStartAt = &startAt
		stop.Timing.EstimatedDepartureAt = &endAt
		window := nap.Window
		stop.Timing.FixedEventInterval = &window
		plan.Stops = append(append(append([]c.Stop{}, morning.Stops...), stop), afternoon.Stops...)
		plan.Legs = append(append([]c.Leg{}, morning.Legs...), afternoon.Legs...)
		if len(morning.Legs) > 0 {
			plan.Legs[len(morning.Legs)-1].To = ref("stop", napID)
		}
		if len(afternoon.Legs) > 0 {
			plan.Legs[len(morning.Legs)].From = ref("stop", napID)
		}
		for i := range plan.Legs {
			plan.Legs[i].LegID = c.ID(fmt.Sprintf("leg-%s-nap-%d", day.Date, i+1))
		}
		plan.Totals.WalkDistanceM = add(morning.Totals.WalkDistanceM, *afternoon.Totals.WalkDistanceM)
		plan.Totals.WalkDurationSec = add(morning.Totals.WalkDurationSec, *afternoon.Totals.WalkDurationSec)
		plan.Totals.VisitDurationSec = morning.Totals.VisitDurationSec + afternoon.Totals.VisitDurationSec
		plan.Totals.MealDurationSec = morning.Totals.MealDurationSec + afternoon.Totals.MealDurationSec
		plan.Totals.RestDurationSec = morning.Totals.RestDurationSec + afternoon.Totals.RestDurationSec
		plan.Totals.WaitDurationSec = add(morning.Totals.WaitDurationSec, *afternoon.Totals.WaitDurationSec+homeWait)
		plan.Totals.ElapsedDurationSec = &elapsed
		plan.Totals.OutingDurationSec = &outing
		plan.Totals.NapDurationSec = &sleepSec
		plan.Nap = &c.NapDayInfo{Window: nap.Window, Location: nap.Location, LatestStartAt: instant(latest), EarlyArrivalWaitSec: homeWait, StartTimeIsEstimated: true}
		score := math.Abs(float64(len(before)-len(after)))*60 + outing
		if len(input.Selections) >= 2 && (len(before) == 0 || len(after) == 0) {
			score += 86400
		} // Prefer an outing on both sides when feasible.
		feasible := plan.Feasibility != "infeasible"
		oldFeasible := bestSet && best.Feasibility != "infeasible"
		if !bestSet || feasible && !oldFeasible || feasible == oldFeasible && score <= bestScore {
			best = plan
			bestScore = score
			bestSet = true
		}
	}
	view.Days = []c.DayPlan{best}
	view.Warnings = append([]c.Warning{}, best.Warnings...)
	view.Status = "planned"
	view.Version++
	view.UpdatedAt = instant(now)
	return view, nil
}

func validateNapPreference(nap *c.NapPreference) error {
	if nap == nil {
		return nil
	}
	a, e1 := time.Parse("15:04", nap.StartTime)
	b, e2 := time.Parse("15:04", nap.EndTime)
	if e1 != nil || e2 != nil || a.Format("15:04") != nap.StartTime || b.Format("15:04") != nap.EndTime || !a.Before(b) {
		return invalid("Укажите начало и окончание дневного сна в пределах одного дня (ЧЧ:ММ).")
	}
	return nil
}
func validateNap(day c.DayInput) error {
	if day.Nap == nil {
		return nil
	}
	nap := day.Nap
	if day.AvailableWindow == nil {
		return invalid("Для дневного сна нужно календарное окно дня.")
	}
	a, e1 := parseInstant(nap.Window.StartAt)
	b, e2 := parseInstant(nap.Window.EndAt)
	end, e3 := parseInstant(day.AvailableWindow.EndAt)
	zone := time.FixedZone("Europe/Moscow", 10800)
	if e1 != nil || e2 != nil || e3 != nil || !a.Before(b) || a.In(zone).Format("2006-01-02") != string(day.Date) || b.In(zone).Format("2006-01-02") != string(day.Date) || b.After(end) {
		return invalid("Дневной сон должен быть в выбранную дату и заканчиваться до конца дня.")
	}
	if err := (routing.Request{From: nap.Location, To: nap.Location, Mode: "walk"}).Validate(); err != nil {
		return invalid("Укажите адрес жилья в зоне построения маршрутов.")
	}
	return nil
}

func touristStopCount(day c.DayPlan) int {
	n := 0
	for _, s := range day.Stops {
		if stopKind(s) != "nap" {
			n++
		}
	}
	return n
}

func (p Planner) napChoiceRank(selection c.Selection, day c.DayInput) int {
	candidate, ok := p.metadata[selection.ActivityID]
	if !ok {
		return 0
	}
	sleepStart, _ := parseInstant(day.Nap.Window.StartAt)
	sleepEnd, _ := parseInstant(day.Nap.Window.EndAt)
	before, after := false, false
	for _, a := range candidate.Availability {
		if a.Date != day.Date {
			continue
		}
		if a.State == "unknown" {
			return 0
		}
		for _, w := range a.VisitWindows {
			start, _ := parseInstant(w.StartAt)
			end, _ := parseInstant(w.EndAt)
			duration := time.Duration(candidate.Activity.Duration.DurationSec * float64(time.Second))
			before = before || !start.Add(duration).After(sleepStart) && !start.Add(duration).After(end)
			at := start
			if at.Before(sleepEnd) {
				at = sleepEnd
			}
			after = after || !at.Add(duration).After(end) && (a.LastEntryAt == nil || func() bool { last, _ := parseInstant(*a.LastEntryAt); return !at.After(last) }())
		}
		for _, o := range a.Occurrences {
			if selection.OccurrenceID != nil && o.OccurrenceID != *selection.OccurrenceID {
				continue
			}
			start, _ := parseInstant(o.Interval.StartAt)
			end, _ := parseInstant(o.Interval.EndAt)
			before = before || !end.After(sleepStart)
			after = after || !start.Before(sleepEnd)
		}
	}
	if before && !after {
		return -1
	}
	if after && !before {
		return 1
	}
	return 0
}
