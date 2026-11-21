// Compare explicit choices with the complete multi-day proposal, not only today's stops.
export function selectionReview(trip) {
 const scheduled=new Set(trip.days.flatMap(day=>day.stops.map(stop=>stop.activity_id)));
 const candidates=new Map((trip.recommendation_snapshot?.candidates||[]).map(c=>[c.activity.activity_id,c]));
 const reasons=new Map((trip.warnings||[]).filter(w=>w.code==='CANDIDATE_NOT_SCHEDULED'&&w.activity_id).map(w=>[w.activity_id,w.message]));
 const cards=trip.input.selections.map(selection=>({activityId:selection.activity_id,title:candidates.get(selection.activity_id)?.activity.title||selection.activity_id,missing:!scheduled.has(selection.activity_id),reason:reasons.get(selection.activity_id)?.includes('При проверке вариантов:')?reasons.get(selection.activity_id):'Не включено в расчёт всей поездки. Причина не уточнена — пересчитайте маршрут.'}));
 return {cards,excludedCount:cards.filter(card=>card.missing).length};
}
