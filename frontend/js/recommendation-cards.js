// Cards carry ML IDs and a chosen day. Static presentation IDs never enter TripInput.
export function candidateCard(candidate, date) {
  const place = candidate.place, activity = candidate.activity;
  const session = candidate.availability.find(a => a.date === date)?.occurrences?.find(o => o.booking_status !== 'sold_out');
  return {
    id: activity.activity_id, activity_id: activity.activity_id, place_id: place.place_id,
    preferred_date: date, occurrence_id: activity.kind === 'session' ? session?.occurrence_id || null : null,
    title: activity.title, category_key:place.categories[0], category: ({museum:'Музей',park:'Парк',landmark:'Достопримечательность',event:'Событие'}[place.categories[0]] || 'Место для прогулки'),
    address: place.address || place.location.label || '', location: place.entrance?.coordinates || place.location.coordinates,
    text: [...candidate.reasons.map(r => r.message), `Посещение: около ${Math.round(activity.duration.duration_sec / 60)} мин.`],
    image: null,
  };
}
export function manualSelection(card) {
  return { activity_id: card.activity_id, place_id: card.place_id, occurrence_id: card.occurrence_id || null, mandatory: false, preferred_date: card.preferred_date };
}
export const MIN_PER_DAY = 2;
export const planningPolicyForSelections = selections => selections.length ? 'manual_choices' : 'ranked_prefix';
export function pickConfiguration(options, { supplemental = false, selected = [] } = {}) {
  if (!supplemental) {
    const available=new Set(options.days.flatMap(d=>d.candidates.map(c=>c.activity.activity_id)));
    // Сверху мест не ограничено; снизу — не меньше двух на каждый день (minTotal), иначе маршрут получится пустым
    return { days:[], tripLimit:Infinity, minPerDay:MIN_PER_DAY, minTotal:MIN_PER_DAY*options.days.length,
      cards:options.candidates.filter(c=>available.has(c.activity.activity_id)).map(c=>candidateCard(c,null)),
      selected:selected.map(c=>({...c,preferred_date:null,occurrence_id:null})),
    };
  }
  const days = options.days.filter(d => !supplemental || d.is_short && d.remaining_manual_choices > 0 && d.candidates.length);
  return {
    days: days.map(d => ({date:d.date,limit:Infinity,anchorOnFirstPick:d.anchor===null,radiusM:options.policy.supplement_radius_m})),
    cardsByDay: Object.fromEntries(days.map(d => [d.date,d.candidates.map(c => candidateCard(c,d.date))])),
    selected,
  };
}
export function withinCardRadius(a,b,radiusM) {
  const lat1=a[1]*Math.PI/180,lat2=b[1]*Math.PI/180;
  const x=Math.sin((lat2-lat1)/2),y=Math.sin((b[0]-a[0])*Math.PI/360);
  return 6371008.8*2*Math.asin(Math.sqrt(Math.min(1,x*x+Math.cos(lat1)*Math.cos(lat2)*y*y)))<=radiusM;
}
