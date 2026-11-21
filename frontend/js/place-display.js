const PLACE_EMOJI = {lodging:'🌙',toilets:'🚻',toilet:'🚻',cafe:'🍽️',restaurant:'🍽️',playground:'🛝',park:'🌳',bench:'🪑',pharmacy:'💊',museum:'🏛️',landmark:'🏛️',event:'🎭',theatre:'🎭'};
export const placeEmoji = kind => Object.hasOwn(PLACE_EMOJI,kind) ? PLACE_EMOJI[kind] : '📍';
const CATEGORY_ICONS = {lodging:'lodging',toilets:'toilet',toilet:'toilet',cafe:'food',restaurant:'food',playground:'playground',park:'park',bench:'bench',pharmacy:'pharmacy',museum:'landmark',landmark:'landmark',event:'event',theatre:'event'};
export const emojiAsset = kind => '/assets/category-icons/'+(Object.hasOwn(CATEGORY_ICONS,kind)?CATEGORY_ICONS[kind]:'pin')+'.svg';
export const placeEmojiHtml = kind => '<img class="place-emoji" src="'+emojiAsset(kind)+'" alt="" aria-hidden="true">';
export function createPlaceEmoji(kind) {
 const image=document.createElement('img');image.className='place-emoji';image.src=emojiAsset(kind);image.alt='';image.setAttribute('aria-hidden','true');image.draggable=false;return image;
}
export const BENCH_SPACING_M = 50;
// Sorted by GPS distance first: keep the closest representative of each group.
export function thinBenches(places, distance) {
  const kept=[];
  return [...places].sort((a,b)=>(a.distance_m??0)-(b.distance_m??0) || String(a.place_id).localeCompare(String(b.place_id))).filter(p=>{
    if(!p.categories.includes('bench'))return true;
    if(kept.some(other=>distance(other.location.coordinates,p.location.coordinates)<BENCH_SPACING_M))return false;
    kept.push(p);return true;
  });
}
