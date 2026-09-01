(()=>{
'use strict';
const ENDPOINT='https://uwcqvsitjtknxsaypjxj.supabase.co/functions/v1/emergency-response';
const DB_NAME='masinloc-emergency-v1';
const DB_VERSION=1;
const AGENCY_LABEL={pnp:'PNP',mdrrmo:'MDRRMO'};
const TYPES={
  pnp:[['','Choose incident type'],['crime','Crime / ongoing incident'],['threat','Threat / immediate danger'],['suspicious_activity','Suspicious activity'],['missing_person','Missing person'],['accident','Road / vehicle accident'],['traffic','Traffic / public safety'],['other','Other police concern']],
  mdrrmo:[['','Choose incident type'],['flood','Flood / rising water'],['fire','Fire'],['rescue','Rescue / trapped person'],['medical','Medical emergency / ambulance'],['storm_hazard','Storm / fallen tree / hazard'],['evacuation','Evacuation assistance'],['accident','Accident / rescue needed'],['other','Other emergency / disaster concern']]
};
const STATUS_COPY={
  saved_offline:['Saved Offline · Not Yet Received','This report is stored on this device. PNP/MDRRMO has not received it yet.'],
  sending:['Sending','A connection was detected. We are attempting delivery now.'],
  received:['Received by emergency system','The server accepted your report. Human acknowledgement may still be pending.'],
  acknowledged:['Acknowledged','An authorized responder/operator has acknowledged this report.'],
  assigned:['Responder assigned','The incident has been assigned to a unit or responder.'],
  dispatched:['Dispatched','A response unit has been dispatched.'],
  en_route:['Responder en route','The assigned response unit is on the way.'],
  on_scene:['Responder on scene','The response team marked the incident as on scene.'],
  resolved:['Resolved','The response team marked this incident resolved.'],
  closed:['Closed','This incident record has been closed.']
};
const $=s=>document.querySelector(s);
let selectedAgency=null;
/* Resident intent. Emergency unless they say otherwise — an unset mode must
   fail towards urgent. Never a priority; the agency owns that. */
let reportMode='emergency';
let locationFix=null;
let active=null;
let serverMessages=[];
let pollTimer=null;

function openDB(){return new Promise((resolve,reject)=>{const r=indexedDB.open(DB_NAME,DB_VERSION);r.onupgradeneeded=()=>{const db=r.result;if(!db.objectStoreNames.contains('reports'))db.createObjectStore('reports',{keyPath:'client_report_id'});if(!db.objectStoreNames.contains('messages'))db.createObjectStore('messages',{keyPath:'client_message_id'});};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);})}
async function tx(store,mode,work){const db=await openDB();return new Promise((resolve,reject)=>{const t=db.transaction(store,mode),s=t.objectStore(store);let value;try{value=work(s)}catch(e){db.close();reject(e);return}t.oncomplete=()=>{db.close();resolve(value)};t.onerror=()=>{db.close();reject(t.error)};})}
async function putReport(r){await tx('reports','readwrite',s=>s.put(r))}
async function putMessage(m){await tx('messages','readwrite',s=>s.put(m))}
// One report by key. Used to re-read a report's committed state immediately
// before sending, so a caller holding a stale snapshot cannot re-deliver
// something another pass already confirmed.
async function getReport(clientReportId){const db=await openDB();return new Promise((resolve,reject)=>{const t=db.transaction('reports','readonly'),r=t.objectStore('reports').get(clientReportId);r.onsuccess=()=>resolve(r.result||null);r.onerror=()=>reject(r.error);t.oncomplete=()=>db.close();})}
async function getReports(){const db=await openDB();return new Promise((resolve,reject)=>{const t=db.transaction('reports','readonly'),r=t.objectStore('reports').getAll();r.onsuccess=()=>resolve(r.result||[]);r.onerror=()=>reject(r.error);t.oncomplete=()=>db.close();})}
async function getMessages(clientReportId){const db=await openDB();return new Promise((resolve,reject)=>{const t=db.transaction('messages','readonly'),r=t.objectStore('messages').getAll();r.onsuccess=()=>resolve((r.result||[]).filter(x=>x.client_report_id===clientReportId));r.onerror=()=>reject(r.error);t.oncomplete=()=>db.close();})}

function randomSecret(){const bytes=new Uint8Array(32);crypto.getRandomValues(bytes);let s='';bytes.forEach(b=>s+=String.fromCharCode(b));return btoa(s).replaceAll('+','-').replaceAll('/','_').replaceAll('=','')}
function esc(v){return String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]))}
function formatDate(v){if(!v)return '—';try{return new Intl.DateTimeFormat('en-PH',{dateStyle:'medium',timeStyle:'short'}).format(new Date(v))}catch{return '—'}}
function setConnection(){const el=$('#connectionPill'),online=navigator.onLine;el.classList.toggle('online',online);el.classList.toggle('offline',!online);el.querySelector('b').textContent=online?'Online':'Offline';}
function showError(msg){const e=$('#formError');e.textContent=msg;e.hidden=!msg}
function setSending(on){$('#submitReport').disabled=on;$('#submitReport').textContent=on?'Saving report…':'Send emergency report'}

function agencySelect(agency){selectedAgency=agency;document.querySelectorAll('[data-agency]').forEach(b=>{const selected=b.dataset.agency===agency;b.classList.toggle('selected',selected);b.setAttribute('aria-pressed',selected?'true':'false')});const select=$('#incidentType');select.innerHTML=TYPES[agency].map(([v,l])=>`<option value="${v}">${l}</option>`).join('');$('#modePicker').hidden=false;$('#reportPanel').hidden=false;$('#modePicker').scrollIntoView({behavior:'smooth',block:'start'});captureGPS(false).catch(()=>{});}

document.querySelectorAll('[data-agency]').forEach(b=>b.addEventListener('click',()=>agencySelect(b.dataset.agency)));
function modeSelect(mode){reportMode=mode==='assistance'?'assistance':'emergency';document.querySelectorAll('[data-mode]').forEach(x=>{const on=x.dataset.mode===reportMode;x.classList.toggle('selected',on);x.setAttribute('aria-pressed',on?'true':'false')});
$('#modeNote').textContent=reportMode==='assistance'?'The same desk receives this. It is not watched continuously — if the situation changes, call 911 or send an emergency report.':'Either way the same desk receives it. If you are unsure, choose Emergency.';}
document.querySelectorAll('[data-mode]').forEach(x=>x.addEventListener('click',()=>modeSelect(x.dataset.mode)));

function geolocate(){return new Promise((resolve,reject)=>{if(!navigator.geolocation){reject(new Error('Location is not supported by this browser.'));return}navigator.geolocation.getCurrentPosition(resolve,reject,{enableHighAccuracy:true,timeout:12000,maximumAge:0})})}
async function captureGPS(quiet=false){const card=$('#locationCard'),button=$('#locationBtn');button.disabled=true;button.textContent='Locating…';if(!quiet){$('#locationTitle').textContent='Getting your location';$('#locationMeta').textContent='Keep this page open while the phone attempts a GPS fix.'}try{const pos=await geolocate();locationFix={latitude:pos.coords.latitude,longitude:pos.coords.longitude,accuracy_m:pos.coords.accuracy,location_captured_at:new Date(pos.timestamp||Date.now()).toISOString()};card.classList.remove('failed');card.classList.add('captured');$('#locationTitle').textContent='Location captured';$('#locationMeta').textContent=`${locationFix.latitude.toFixed(6)}, ${locationFix.longitude.toFixed(6)} · accuracy ±${Math.round(locationFix.accuracy_m)} m`;return locationFix}catch(err){card.classList.remove('captured');card.classList.add('failed');$('#locationTitle').textContent='GPS unavailable';$('#locationMeta').textContent='Enter the barangay and nearest landmark below. You can retry GPS at any time.';throw err}finally{button.disabled=false;button.textContent='Refresh GPS'}}
$('#locationBtn').addEventListener('click',()=>captureGPS(false).catch(()=>{}));

async function api(payload){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);try{const r=await fetch(ENDPOINT,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),cache:'no-store',signal:controller.signal});let data={};try{data=await r.json()}catch{}if(!r.ok||!data.ok)throw new Error(data.error||`Request failed (${r.status})`);return data}finally{clearTimeout(timer)}}

function buildReport(){return{
  client_report_id:crypto.randomUUID(),report_secret:randomSecret(),target_agency:selectedAgency,report_mode:reportMode,incident_type:$('#incidentType').value,
  description:$('#description').value.trim(),reporter_name:$('#reporterName').value.trim()||null,reporter_contact:$('#reporterContact').value.trim()||null,
  contact_preference:$('#contactPreference').value||'chat',latitude:locationFix?.latitude??null,longitude:locationFix?.longitude??null,accuracy_m:locationFix?.accuracy_m??null,
  location_captured_at:locationFix?.location_captured_at??null,barangay:$('#barangay').value.trim()||null,landmark:$('#landmark').value.trim()||null,
  source_created_at:new Date().toISOString(),sync_state:'queued',status:'saved_offline',reference:null,received_at:null,updated_local_at:new Date().toISOString()
}}

function validateForm(){if(!selectedAgency)return 'Choose PNP or MDRRMO.';if(!$('#incidentType').value)return 'Choose an incident type.';if($('#description').value.trim().length<3)return 'Describe what is happening.';if(!locationFix&&!$('#barangay').value.trim()&&!$('#landmark').value.trim())return 'Allow GPS or enter a barangay / landmark so responders know where help is needed.';return ''}

$('#reportForm').addEventListener('submit',async e=>{e.preventDefault();showError('');const error=validateForm();if(error){showError(error);return}setSending(true);try{try{await captureGPS(true)}catch{}const recheck=validateForm();if(recheck){showError(recheck);return}const report=buildReport();await putReport(report);active=report;serverMessages=[];await showActive();if(navigator.onLine)await flushReport(active);else registerSync();}catch(err){showError(err instanceof Error?err.message:'Could not save the report on this device.')}finally{setSending(false)}});

/* Delivery is single-flight, per report and overall.

   Reconnecting fires more than one trigger at once — the browser's own
   'online' event, the focus handler, visibilitychange, and Background Sync can
   all land within the same tick. Each used to start its own flushAll, and each
   read the queue before the others had written back, so a report that one pass
   had already delivered was re-sent by the next. The visible effect was the
   one thing this page must never do: a confirmed reference flickering back to
   'Pending delivery' and the status card back to 'Sending', on somebody's
   emergency report. Caught by emergency-browser-qa.mjs.

   Two guards. inFlight keeps one send per client_report_id, so overlapping
   triggers coalesce instead of racing. And the report's state is re-read from
   IndexedDB immediately before sending rather than trusted from the caller's
   snapshot, because that snapshot may have been taken before another pass
   delivered it. */
const inFlight=new Set();
async function flushReport(report){if(!navigator.onLine||report.sync_state==='delivered')return report;
if(inFlight.has(report.client_report_id))return report;
/* Claimed synchronously, before the first await. Reading storage between the
   check and the claim yields, so two callers both passed the check before
   either had claimed and the guard never fired. Nothing may suspend between
   these two lines. */
inFlight.add(report.client_report_id);
try{
const stored=await getReport(report.client_report_id);
/* The committed state decides, not the caller's snapshot: a path that started
   before another finished would otherwise re-send a delivered report and roll
   its confirmed reference back to 'Pending delivery'. */
if(stored&&stored.sync_state==='delivered'){if(active&&active.client_report_id===stored.client_report_id){active=stored;renderActiveMeta();renderStatus()}return stored}report.sync_state='sending';report.status='sending';report.updated_local_at=new Date().toISOString();await putReport(report);active=report;renderStatus();try{const data=await api({action:'submit',report});report.sync_state='delivered';report.status=data.status||'received';report.reference=data.reference||report.reference;report.received_at=data.received_at||report.received_at;report.updated_local_at=new Date().toISOString();await putReport(report);active=report;renderActiveMeta();renderStatus();await refreshStatus(false);return report}catch(err){report.sync_state='queued';report.status='saved_offline';report.last_error=err instanceof Error?err.message:'Delivery failed';report.updated_local_at=new Date().toISOString();await putReport(report);active=report;renderStatus();registerSync();return report}}finally{inFlight.delete(report.client_report_id)}}

async function refreshStatus(showFailure=true){if(!active||active.sync_state!=='delivered'||!navigator.onLine)return;try{const data=await api({action:'status',client_report_id:active.client_report_id,report_secret:active.report_secret});const i=data.incident||{};active.status=i.status||active.status;active.reference=i.public_reference||active.reference;active.received_at=i.received_at||active.received_at;active.acknowledged_at=i.acknowledged_at||null;active.assigned_unit=i.assigned_unit||null;active.priority=i.priority||active.priority;active.resolved_at=i.resolved_at||null;active.updated_local_at=new Date().toISOString();serverMessages=data.messages||[];await putReport(active);renderActiveMeta();renderStatus();await renderMessages();}catch(err){if(showFailure)$('#messageHint').textContent='Could not refresh right now. Your saved report remains on this device.';}}

/* The delivery rail.

   Two things it exists to keep apart, because collapsing them is the failure
   this whole page is built around:

     RECEIVED      the server accepted the report. Nobody has read it.
     ACKNOWLEDGED  an authorised responder has.

   And "Saved Offline · Not Yet Received" is not a step forward. It is rendered
   as a warning row, never as progress, and it is never treated as reaching
   RECEIVED — not visually and not in the data this reads. */
const RAIL = [
  ['received',     'RECEIVED',     'The server accepted your report.'],
  ['acknowledged', 'ACKNOWLEDGED', 'An authorised responder has seen it.'],
  ['assigned',     'ASSIGNED',     'A unit or responder was assigned.'],
  ['dispatched',   'DISPATCHED',   'A unit was dispatched.'],
  ['en_route',     'EN ROUTE',     'The unit is on the way.'],
  ['on_scene',     'ON SCENE',     'The unit has arrived.'],
  ['resolved',     'RESOLVED',     'The agency closed this incident.'],
];

function renderRail(){
  const rail=$('#statusRail');
  if(!rail||!active)return;
  const delivered=active.sync_state==='delivered';
  const sending=active.sync_state==='sending';
  /* Only a delivered report has an operational status worth reading. An
     undelivered one has not reached the server, so nothing after it can have
     happened yet, whatever a stale local field says. */
  const reached=delivered?RAIL.findIndex(s=>s[0]===(active.status==='closed'?'resolved':active.status)):-1;

  const rows=[];
  if(!delivered){
    rows.push(sending
      ? ['is-current','SENDING','Attempting delivery now.']
      : ['is-offline','SAVED OFFLINE · NOT YET RECEIVED','Stored on this device. PNP/MDRRMO has not received it.']);
  }
  RAIL.forEach(([key,name,what],i)=>{
    let state='';
    if(delivered&&reached>=0){
      if(i<reached)state='is-done';
      else if(i===reached)state='is-current';
    }
    rows.push([state,name,what]);
  });

  rail.innerHTML=rows.map(([state,name,what])=>
    `<li class="rail-step ${state}"><span class="rail-mark" aria-hidden="true"></span>`+
    `<span class="rail-body"><span class="rail-name">${esc(name)}</span>`+
    `<span class="rail-what">${esc(what)}</span></span></li>`).join('');
}

function renderStatus(){if(!active)return;const state=active.sync_state!=='delivered'?(active.status==='sending'?'sending':'saved_offline'):active.status;const copy=STATUS_COPY[state]||[state,'Status updated.'];const card=$('#statusCard');card.className=`status-card ${state}`;$('#statusLabel').textContent=copy[0];$('#statusExplanation').textContent=copy[1];renderRail();}
function renderActiveMeta(){if(!active)return;$('#activeReportTitle').textContent=`${AGENCY_LABEL[active.target_agency]} emergency report`;$('#referenceValue').textContent=active.reference||'Pending delivery';$('#agencyValue').textContent=AGENCY_LABEL[active.target_agency];$('#createdValue').textContent=formatDate(active.source_created_at);$('#gpsValue').textContent=active.latitude!==null&&active.latitude!==undefined?`${Number(active.latitude).toFixed(5)}, ${Number(active.longitude).toFixed(5)}${active.accuracy_m?` ±${Math.round(active.accuracy_m)}m`:''}`:'Manual location';}
async function renderMessages(){const local=(await getMessages(active.client_report_id)).filter(m=>m.sync_state!=='delivered');const combined=[...serverMessages.map(m=>({...m,local:false})),...local.map(m=>({...m,local:true}))].sort((a,b)=>new Date(a.created_at||a.source_created_at).getTime()-new Date(b.created_at||b.source_created_at).getTime());const box=$('#messages');if(!combined.length){box.innerHTML='<div class="message system">No responder messages yet.<small>Updates will appear here after delivery.</small></div>';return}box.innerHTML=combined.map(m=>{const kind=m.sender_kind==='resident'?'resident':m.sender_kind==='system'?'system':'agency';const who=kind==='resident'?'You':kind==='system'?'System':String(m.sender_agency||m.sender_kind||'Responder').toUpperCase();return `<div class="message ${kind}"><strong>${esc(who)}</strong><div>${esc(m.body)}</div><small>${m.local?'Queued · not yet received':formatDate(m.created_at)}</small></div>`}).join('');box.scrollTop=box.scrollHeight;}

async function showActive(){if(!active)return;$('#agencyTitle').closest('.agency-picker').hidden=true;$('#reportPanel').hidden=true;$('#activeReport').hidden=false;renderActiveMeta();renderStatus();await renderMessages();$('#activeReport').scrollIntoView({behavior:'smooth',block:'start'});startPolling();}
function startPolling(){clearInterval(pollTimer);pollTimer=setInterval(()=>{if(document.visibilityState==='visible')refreshStatus(false)},15000)}

$('#refreshStatus').addEventListener('click',()=>refreshStatus(true));
$('#newReportBtn').addEventListener('click',()=>{active=null;serverMessages=[];selectedAgency=null;reportMode='emergency';locationFix=null;clearInterval(pollTimer);$('#activeReport').hidden=true;$('#reportPanel').hidden=true;$('#modePicker').hidden=true;$('#agencyTitle').closest('.agency-picker').hidden=false;document.querySelectorAll('[data-agency]').forEach(b=>{b.classList.remove('selected');b.setAttribute('aria-pressed','false')});modeSelect('emergency');$('#reportForm').reset();window.scrollTo({top:0,behavior:'smooth'});});

$('#messageForm').addEventListener('submit',async e=>{e.preventDefault();if(!active)return;const body=$('#messageInput').value.trim();if(!body)return;const m={client_message_id:crypto.randomUUID(),client_report_id:active.client_report_id,sender_kind:'resident',body,source_created_at:new Date().toISOString(),created_at:new Date().toISOString(),sync_state:'queued'};await putMessage(m);$('#messageInput').value='';await renderMessages();if(active.sync_state!=='delivered'){$('#messageHint').textContent='Message queued. It will send after the report is received.';registerSync();return}await flushMessage(m);});

async function flushMessage(m){if(!navigator.onLine||!active||active.sync_state!=='delivered')return;try{await api({action:'message',client_report_id:active.client_report_id,report_secret:active.report_secret,client_message_id:m.client_message_id,message:m.body});m.sync_state='delivered';await putMessage(m);$('#messageHint').textContent='Message delivered to the report thread.';await refreshStatus(false);}catch{$('#messageHint').textContent='Message saved on this device and queued for retry.';registerSync();await renderMessages();}}

let flushing=null;
function flushAll(){/* Overlapping callers share one pass rather than starting their own. */if(flushing)return flushing;flushing=runFlush().finally(()=>{flushing=null});return flushing}
async function runFlush(){setConnection();if(!navigator.onLine)return;const reports=(await getReports()).sort((a,b)=>new Date(a.source_created_at).getTime()-new Date(b.source_created_at).getTime());for(const r of reports.filter(x=>x.sync_state!=='delivered'))await flushReport(r);for(const r of reports.filter(x=>x.sync_state==='delivered')){const msgs=await getMessages(r.client_report_id);for(const m of msgs.filter(x=>x.sync_state!=='delivered')){const previous=active;active=r;await flushMessage(m);active=previous;}}if(active&&active.sync_state==='delivered')await refreshStatus(false)}

async function registerSync(){if(!('serviceWorker'in navigator))return;try{const reg=await navigator.serviceWorker.ready;if('sync'in reg)await reg.sync.register('masinloc-emergency-sync')}catch{}}

window.addEventListener('online',()=>flushAll());window.addEventListener('offline',setConnection);window.addEventListener('focus',()=>flushAll());document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')flushAll()});

async function boot(){setConnection();if('serviceWorker'in navigator){try{await navigator.serviceWorker.register('sw.js',{scope:'./'})}catch{}}const reports=await getReports();if(reports.length){reports.sort((a,b)=>new Date(b.source_created_at).getTime()-new Date(a.source_created_at).getTime());active=reports[0];if(active.sync_state==='delivered' || active.sync_state==='queued' || active.sync_state==='sending'){serverMessages=[];await showActive();}}await flushAll();}
boot().catch(()=>setConnection());
})();