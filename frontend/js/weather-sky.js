// Compact dynamic weather icon; no canvas, animation or overlay on map features.
import { onTripChange, today } from './api.js';
import { forecastFor, skyKind } from './weather.js';
const skies={clear:['☀️','Ясно'],partly:['⛅','Облачно'],cloud:['☁️','Пасмурно'],rain:['🌦️','Дождь'],heavyrain:['🌧️','Сильный дождь'],thunder:['⛈️','Гроза'],snow:['🌨️','Снег'],fog:['🌫️','Туман']};
let root,lastKey='',revision=0;
export function setSky(kind){
 if(!root)return;
 const sky=skies[kind];root.hidden=!sky;
 if(!sky)return;
 root.dataset.sky=kind;root.querySelector('[data-weather-icon]').textContent=sky[0];
 root.setAttribute('aria-label','Погода: '+sky[1]);root.title='Погода: '+sky[1];
}
async function update(){
 const day=today();if(!day){lastKey='';revision++;setSky(null);return;}
 const key=JSON.stringify([day.date,day.start_point.coordinates,day.available_window]);
 if(key===lastKey)return;lastKey=key;const ticket=++revision;setSky(null);
 try{const forecast=await forecastFor(day);if(ticket!==revision)return;setSky(forecast?skyKind(forecast.h):null);}
 catch{if(ticket===revision){lastKey='';setSky(null);}}
}
export function initWeatherSky(el){root=el;onTripChange(update);update();}
