// Family preference supplies defaults only; every trip can independently enable sleep.
export function tripNapDefaults(state={},preference=null){
 const migrated=state.napSettingsVersion===1;
 return {napSettingsVersion:1,napEnabled:migrated?Boolean(state.napEnabled):state.napEnabled===false?false:Boolean(preference||state.lodging),napStart:state.napStart??preference?.start_time??'13:00',napEnd:state.napEnd??preference?.end_time??'15:00'};
}
export function validTripNapTimes(state){return /^([01]\d|2[0-3]):[0-5]\d$/.test(state.napStart)&&/^([01]\d|2[0-3]):[0-5]\d$/.test(state.napEnd)&&state.napStart<state.napEnd;}
export function tripNapForDate(date,state){
 if(!state.napEnabled||(state.napDisabledDays||[]).includes(date))return null;
 return {location:state.lodging,window:{start_at:date+'T'+state.napStart+':00+03:00',end_at:date+'T'+state.napEnd+':00+03:00'}};
}
