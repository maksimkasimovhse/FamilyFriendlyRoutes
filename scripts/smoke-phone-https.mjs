// Creates a fixture draft in an isolated guest session; validates real TLS/CSRF.
import fs from 'node:fs';
import https from 'node:https';
const env=fs.readFileSync('.env','utf8');
const setting=(name,fallback)=>env.match(new RegExp('^'+name+'=(.*)$','m'))?.[1].trim() || fallback;
const base=process.env.PHONE_HTTPS_URL || `https://${setting('CADDY_HOST','localhost')}:${setting('CADDY_HTTPS_PORT','8443')}`;
const publicTunnel=new URL(base).hostname.endsWith('.trycloudflare.com');
const ca=publicTunnel ? undefined : fs.readFileSync('infra/docker/certs/family-routes-root.crt');
function request(path,body,headers={}) {
  return new Promise((resolve,reject)=>{
    const req=https.request(base+path,{ca,method:body?'POST':'GET',headers:{...headers,...(body?{'Content-Type':'application/json'}:{})},timeout:10000},res=>{
      const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}));
    });
    req.on('error',reject);req.on('timeout',()=>req.destroy(Error('timeout')));
    if(body)req.write(JSON.stringify(body));req.end();
  });
}
const page=await request('/');
if(page.status!==200 || !page.body.includes('Окно в прошлое'))throw Error('HTTPS frontend failed');
if(page.headers['permissions-policy']!=='geolocation=(self)')throw Error('Geolocation policy absent');
const session=await request('/api/v1/session');
if(session.status!==200)throw Error('Session failed');
const setCookie=session.headers['set-cookie'][0];
if(!setCookie.includes('Secure'))throw Error('HTTPS session is not Secure');
const cookie=setCookie.split(';')[0],csrf=JSON.parse(session.body).csrf_token;
const input=JSON.parse(fs.readFileSync('examples/trip-one-day.json','utf8'));
const headers={Cookie:cookie,'X-CSRF-Token':csrf,Origin:base,'Idempotency-Key':crypto.randomUUID()};
const trip=await request('/api/v1/trips',input,headers);
if(trip.status!==201)throw Error('HTTPS CSRF/session failed: '+trip.status+' '+trip.body);
const bad=await request('/api/v1/trips',input,{...headers,Origin:base.replace('https:','http:'),'Idempotency-Key':crypto.randomUUID()});
if(bad.status!==403)throw Error('Wrong-scheme Origin accepted');
const svg=await request('/assets/category-icons/food.svg');
if(svg.status!==200 || !svg.body.startsWith('<svg'))throw Error('Assets failed over HTTPS');
const spoof=await fetch('http://127.0.0.1:8000/api/v1/session',{headers:{'X-Forwarded-Proto':'https'}});
if(!spoof.ok || spoof.headers.getSetCookie()[0].includes('Secure'))throw Error('HTTP ingress accepted a spoofed protocol');
console.log(JSON.stringify({https:publicTunnel?'verified public CA':'verified with root CA',frontend:page.status,secure_cookie:true,csrf_mutation:trip.status,wrong_origin:bad.status,assets:svg.status,http_spoof:'ignored'}));
