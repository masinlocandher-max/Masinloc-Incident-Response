/* The cache name carries the shell's own version, so shipping a fix to
   emergency.js actually reaches a returning device. The fetch handler is
   cache-first for scripts — with a fixed cache name, a corrected emergency.js
   would be served stale indefinitely, which on this page means a fix to
   delivery logic that never arrives. scripts/emergency-qa.mjs checks this
   string against the stamp index.html loads. */
const SHELL_VERSION='20260831-3';
const CACHE=`masinloc-emergency-shell-${SHELL_VERSION}`;
const DB_NAME='masinloc-emergency-v1';
const DB_VERSION=1;
const ENDPOINT='https://uwcqvsitjtknxsaypjxj.supabase.co/functions/v1/emergency-response';
const SHELL=['./','./index.html',`./emergency.css?v=${SHELL_VERSION}`,`./emergency.js?v=${SHELL_VERSION}`,'./manifest.webmanifest','../tokens.css?v=20260823-1','../assets/masinloc-logo.webp','../assets/favicon.svg','../assets/apple-touch-icon.png'];

self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('masinloc-emergency-shell-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',event=>{const req=event.request;if(req.method!=='GET')return;const url=new URL(req.url);if(url.origin!==self.location.origin)return;event.respondWith(caches.match(req).then(hit=>hit||fetch(req).then(res=>{if(res.ok&&['document','script','style','image','manifest'].includes(req.destination)){const copy=res.clone();caches.open(CACHE).then(c=>c.put(req,copy)).catch(()=>{})}return res}).catch(()=>caches.match('./index.html'))))});

function openDB(){return new Promise((resolve,reject)=>{const r=indexedDB.open(DB_NAME,DB_VERSION);r.onupgradeneeded=()=>{const db=r.result;if(!db.objectStoreNames.contains('reports'))db.createObjectStore('reports',{keyPath:'client_report_id'});if(!db.objectStoreNames.contains('messages'))db.createObjectStore('messages',{keyPath:'client_message_id'});};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})}
async function all(store){const db=await openDB();return new Promise((resolve,reject)=>{const t=db.transaction(store,'readonly'),r=t.objectStore(store).getAll();r.onsuccess=()=>resolve(r.result||[]);r.onerror=()=>reject(r.error);t.oncomplete=()=>db.close()})}
async function put(store,value){const db=await openDB();return new Promise((resolve,reject)=>{const t=db.transaction(store,'readwrite');t.objectStore(store).put(value);t.oncomplete=()=>{db.close();resolve()};t.onerror=()=>{db.close();reject(t.error)}})}
async function api(payload){const r=await fetch(ENDPOINT,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),cache:'no-store'});const data=await r.json().catch(()=>({}));if(!r.ok||!data.ok)throw new Error(data.error||'sync failed');return data}
async function syncQueues(){if(!self.navigator.onLine)return;const reports=await all('reports');for(const report of reports.filter(r=>r.sync_state!=='delivered')){
/* Re-read immediately before sending. This runs independently of the page's
   own flush, so by the time Background Sync reaches a report the page may
   already have delivered it. Sending again is harmless — intake is idempotent
   on client_report_id — but writing this stale copy back is not. */
const current=(await all('reports')).find(r=>r.client_report_id===report.client_report_id);
if(!current||current.sync_state==='delivered')continue;
try{const data=await api({action:'submit',report});report.sync_state='delivered';report.status=data.status||'received';report.reference=data.reference||report.reference;report.received_at=data.received_at||report.received_at;report.updated_local_at=new Date().toISOString();await put('reports',report)}
catch{
/* Never downgrade. The previous version wrote 'saved_offline' unconditionally,
   so a failed background attempt on an already-confirmed report reverted it to
   'Not Yet Received' — telling somebody their emergency report had not arrived
   when it had. Only a report that is still undelivered goes back in the queue. */
const latest=(await all('reports')).find(r=>r.client_report_id===report.client_report_id);
if(latest&&latest.sync_state!=='delivered'){latest.sync_state='queued';latest.status='saved_offline';await put('reports',latest)}
}}const refreshed=await all('reports');const byId=new Map(refreshed.map(r=>[r.client_report_id,r]));const messages=await all('messages');for(const message of messages.filter(m=>m.sync_state!=='delivered')){const report=byId.get(message.client_report_id);if(!report||report.sync_state!=='delivered')continue;try{await api({action:'message',client_report_id:report.client_report_id,report_secret:report.report_secret,client_message_id:message.client_message_id,message:message.body});message.sync_state='delivered';await put('messages',message)}catch{}}
const clients=await self.clients.matchAll({type:'window',includeUncontrolled:true});clients.forEach(c=>c.postMessage({type:'emergency-sync-complete'}));}
self.addEventListener('sync',event=>{if(event.tag==='masinloc-emergency-sync')event.waitUntil(syncQueues())});
