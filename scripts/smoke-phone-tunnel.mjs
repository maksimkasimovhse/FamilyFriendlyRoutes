import fs from 'node:fs';
const url=process.env.PHONE_HTTPS_URL || fs.readFileSync('data/backend/phone-tunnel-url.txt','utf8').trim();
if(!/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(url))throw Error('Expected an HTTPS trycloudflare.com URL');
process.env.PHONE_HTTPS_URL=url;
await import('./smoke-phone-https.mjs');
