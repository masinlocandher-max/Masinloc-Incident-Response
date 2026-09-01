import { createMap } from './map.js?v=20260831-3';
import { createClient } from '../assets/vendor/supabase.js?v=2.112.3';
const sb=createClient('https://uwcqvsitjtknxsaypjxj.supabase.co','sb_publishable_qsC-udp3YoJQFuE-lHPivg_wa8gYMeg',{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
const A=document.body.dataset.agency,L=A==='pnp'?'PNP':'MDRRMO',OTHER=A==='pnp'?'mdrrmo':'pnp',OL=OTHER.toUpperCase(),$=s=>document.querySelector(s);
let session=null,rows=[],active=null,messages=[],events=[],mode='public';
const esc=v=>String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
const pretty=v=>String(v||'').replaceAll('_',' ').replace(/\b\w/g,m=>m.toUpperCase());
const date=v=>v?new Intl.DateTimeFormat('en-PH',{dateStyle:'medium',timeStyle:'short'}).format(new Date(v)):'—';
const admin=s=>s?.user?.app_metadata?.role==='admin';
function online(){const e=$('#liveIndicator'),yes=navigator.onLine;e.classList.toggle('offline',!yes);e.querySelector('span').textContent=yes?'Connected':'Offline'}
function note(t,bad=false){const e=$('#toast');e.textContent=t;e.classList.toggle('error',bad);e.hidden=false;setTimeout(()=>e.hidden=true,2600)}
/* The role shown in the header is the one the membership row grants, never a
   title chosen for the screen. A platform admin is shown as exactly that. */
let deskRole='';
async function allowed(s){if(admin(s)){deskRole='Platform admin';return true}const {data}=await sb.from('emergency_agency_members').select('agency,role').eq('user_id',s.user.id).eq('agency',A).eq('active',true).maybeSingle();if(!data)return false;deskRole=data.role?pretty(data.role):`${L} responder`;return true}
function login(){$('#loginView').hidden=false;$('#consoleView').hidden=true;$('#logoutBtn').hidden=true;$('#agencyWho').hidden=true;$('#alertBell').hidden=true}
function consoleView(){$('#loginView').hidden=true;$('#consoleView').hidden=false;$('#logoutBtn').hidden=false;/* The signed-in account, taken from the authenticated session and
   nothing else. No display name is invented for a responder, and none is
   read from anywhere a person could set it to somebody else's. */
const who=$('#agencyAccount');if(who&&session?.user){who.textContent=session.user.email||'Authorized account';$('#agencyRole').textContent=deskRole;$('#agencyWho').hidden=false}}
async function boot(){online();const {data:{session:s}}=await sb.auth.getSession();if(s&&await allowed(s)){session=s;consoleView();await load()}else{if(s)$('#unauthorized').hidden=false;login()}}
$('#loginForm').addEventListener('submit',async e=>{e.preventDefault();$('#loginMessage').textContent='Signing in…';const {data,error}=await sb.auth.signInWithPassword({email:$('#email').value.trim(),password:$('#password').value});if(error){$('#loginMessage').textContent=error.message;return}if(!await allowed(data.session)){await sb.auth.signOut();$('#unauthorized').hidden=false;$('#loginMessage').textContent='';return}session=data.session;consoleView();await load()});
$('#magicBtn').addEventListener('click',async()=>{const email=$('#email').value.trim();if(!email)return $('#loginMessage').textContent='Enter your email first.';const {error}=await sb.auth.signInWithOtp({email,options:{shouldCreateUser:false,emailRedirectTo:location.href.split('#')[0]}});$('#loginMessage').textContent=error?error.message:'Check your email for the secure sign-in link.'});
$('#logoutBtn').addEventListener('click',async()=>{await sb.auth.signOut();session=null;login()});$('#refreshBtn').addEventListener('click',()=>load(true));
async function load(show=false){if(!navigator.onLine){if(show)note('No connection. Live incident records are not cached here.',true);return}const {data:links,error:e1}=await sb.from('emergency_incident_agencies').select('incident_id').eq('agency',A);if(e1)return note(e1.message,true);const ids=[...new Set((links||[]).map(x=>x.incident_id))];if(!ids.length){rows=[];render();return}const {data,error}=await sb.from('emergency_incidents').select('*').in('id',ids).order('received_at',{ascending:false}).limit(500);if(error)return note(error.message,true);rows=data||[];render();if(active&&rows.some(x=>x.id===active.id))await open(active.id);if(show)note('Refreshed')}
/* A fix older than this is no longer "live" — it is the last thing anybody
   actually reported, and the console says so in those words. */
const LIVE_WINDOW_MS = 90 * 1000;

function locationState(row){
  const at = row.location_updated_at || row.location_captured_at;
  if(!at) return { live:false, label:'NO LOCATION', detail:'No coordinates were captured.' };
  const age = Date.now() - new Date(at).getTime();
  /* Live only while the resident is actively sharing AND an update arrived
     inside the window. Anything else is last-known, never interpolated. */
  const live = !!row.live_location && age < LIVE_WINDOW_MS;
  return {
    live,
    label: live ? 'LIVE LOCATION' : 'LAST KNOWN LOCATION',
    detail: `${live?'Updated':'Last received'} ${ago(at)}${row.accuracy_m?` · accuracy ±${Math.round(row.accuracy_m)} m`:''}`,
    at,
  };
}

function ago(iso){
  const s=Math.max(0,Math.round((Date.now()-new Date(iso).getTime())/1000));
  if(s<60)return `${s} sec ago`;
  const m=Math.round(s/60);
  if(m<60)return `${m} min ago`;
  const h=Math.round(m/60);
  return h<24?`${h} hr ago`:`${Math.round(h/24)} d ago`;
}

/* Wall-clock time and age together. An operator radioing a unit needs the time
   the report actually arrived, and the age is what tells them how stale that
   is — either one alone leaves them doing arithmetic during an incident. */
function clock(iso){
  if(!iso)return '—';
  const t=new Date(iso);
  return `${new Intl.DateTimeFormat('en-PH',{hour:'2-digit',minute:'2-digit',hour12:false}).format(t)} · ${ago(iso)}`;
}

/* A mark per kind of incident, so a queue is scannable before it is read.
   The icon says what was reported; it never says how urgent it is — colour
   carries priority, and priority is the agency's judgement. Anything the
   resident form can send has an entry, and anything else falls back to a
   neutral mark rather than to a wrong one. */
const ICON=d=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const MARKS={
  crime:ICON('<path d="M12 2.7 4.8 5.6v6c0 4.4 3 8.5 7.2 9.5 4.2-1 7.2-5.1 7.2-9.5v-6Z"/><path d="M12 8.6v4.6"/><path d="M12 16.2v.1"/>'),
  threat:ICON('<path d="M12 3.4 2.7 19.5h18.6Z"/><path d="M12 9.4v4.1M12 16.7v.1"/>'),
  suspicious_activity:ICON('<circle cx="11" cy="11" r="6.4"/><path d="m16 16 4.4 4.4"/>'),
  missing_person:ICON('<circle cx="12" cy="8.2" r="3.4"/><path d="M5.5 20a6.5 6.5 0 0 1 13 0"/>'),
  accident:ICON('<path d="M4 16.5h16"/><path d="M5.4 16.5v-3.2l1.7-4.1a2 2 0 0 1 1.8-1.2h6.2a2 2 0 0 1 1.8 1.2l1.7 4.1v3.2"/><circle cx="8" cy="18.2" r="1.5"/><circle cx="16" cy="18.2" r="1.5"/>'),
  traffic:ICON('<rect x="8.4" y="2.8" width="7.2" height="14.4" rx="3.2"/><path d="M12 6.4v.1M12 10v.1M12 13.6v.1M12 17.2V21"/>'),
  flood:ICON('<path d="M2.6 16.4c1.9-1.7 3.8-1.7 5.6 0 1.9 1.7 3.8 1.7 5.6 0 1.9-1.7 3.8-1.7 5.6 0"/><path d="M2.6 11.2c1.9-1.7 3.8-1.7 5.6 0 1.9 1.7 3.8 1.7 5.6 0 1.9-1.7 3.8-1.7 5.6 0"/><path d="M2.6 6c1.9-1.7 3.8-1.7 5.6 0 1.9 1.7 3.8 1.7 5.6 0 1.9-1.7 3.8-1.7 5.6 0"/>'),
  fire:ICON('<path d="M12 2.8c2.6 3.1 5.6 5.4 5.6 9.4A5.6 5.6 0 0 1 12 21.2a5.6 5.6 0 0 1-5.6-9c0-4 3-6.3 5.6-9.4Z"/><path d="M12 17.6a2.4 2.4 0 0 1-2.2-3.4c.5-1.1 1.4-1.6 2.2-2.8.8 1.2 1.7 1.7 2.2 2.8a2.4 2.4 0 0 1-2.2 3.4Z"/>'),
  rescue:ICON('<circle cx="12" cy="12" r="8.4"/><circle cx="12" cy="12" r="3.4"/><path d="M12 3.6v3M12 17.4v3M3.6 12h3M17.4 12h3"/>'),
  medical:ICON('<path d="M12 6.4v11.2M6.4 12h11.2"/><rect x="3.2" y="3.2" width="17.6" height="17.6" rx="4"/>'),
  storm_hazard:ICON('<path d="M6.4 15.6a3.8 3.8 0 0 1 .6-7.5 5.2 5.2 0 0 1 10 1.2 3.4 3.4 0 0 1-.6 6.3"/><path d="m12.6 12.4-2.4 4h3.2l-2 4.2"/>'),
  evacuation:ICON('<path d="M13.4 3.4a1.7 1.7 0 1 1 0 .1Z"/><path d="m9.4 21 2-5.6-2.4-2 .8-4.4 3.6-1.4 3 2.2 2.4.8"/><path d="m9.6 12.4-3.8 1.4-1.6 3.4"/>'),
  other:ICON('<circle cx="12" cy="12" r="8.6"/><path d="M12 11v5.4M12 7.6v.1"/>'),
};
const MARK=row=>MARKS[row.incident_type]||MARKS.other;

const DEPLOYED_LABEL = A === 'mdrrmo' ? 'Deployed' : 'En route';
const DEPLOYED_STATES = A === 'mdrrmo'
  ? ['dispatched','en_route','on_scene']
  : ['en_route'];

function render(){
  const live=rows.filter(x=>!['resolved','closed'].includes(x.status));
  const unacknowledged=rows.filter(x=>x.status==='received').length;
  renderViewCounts();
  $('#metrics').innerHTML=
    `<div class="metric urgent m-unack"><span>Unacknowledged</span><strong>${unacknowledged}</strong></div>`+
    `<div class="metric m-active"><span>Active</span><strong>${live.length}</strong></div>`+
    `<div class="metric m-deployed"><span>${DEPLOYED_LABEL}</span><strong>${rows.filter(x=>DEPLOYED_STATES.includes(x.status)).length}</strong></div>`+
    `<div class="metric m-resolved"><span>Resolved</span><strong>${rows.filter(x=>['resolved','closed'].includes(x.status)).length}</strong></div>`;

  /* The bell counts unacknowledged incidents and nothing else. It is not a
     notification feed, so it disappears at zero rather than sitting there
     implying there is something to open. */
  const bell=$('#alertBell'),count=$('#alertCount');
  if(bell&&count){count.textContent=String(unacknowledged);bell.hidden=unacknowledged===0;
    const said=`${unacknowledged} unacknowledged ${unacknowledged===1?'incident':'incidents'}`;bell.title=said;bell.setAttribute('aria-label',said)}

  renderMap();
  renderList()}
let view='all';
/* Views over one queue. Emergency and Assistance read the resident's declared
   report_mode; the operational views read status. Deliberately kept separate:
   an assistance report an officer has escalated to critical still belongs in
   Assistance, because that is what the resident said they sent, and hiding it
   would rewrite their account of their own report. */
const VIEWS={
  all:()=>true,
  emergency:x=>(x.report_mode||'emergency')==='emergency',
  assistance:x=>x.report_mode==='assistance',
  unacknowledged:x=>x.status==='received',
  active:x=>!['resolved','closed'].includes(x.status),
  resolved:x=>['resolved','closed'].includes(x.status),
};
function listRows(){const q=$('#searchInput').value.toLowerCase(),s=$('#statusFilter').value,p=$('#priorityFilter').value;const inView=VIEWS[view]||VIEWS.all;return rows.filter(x=>inView(x)&&(!s||x.status===s)&&(!p||x.priority===p)&&(!q||JSON.stringify([x.public_reference,x.incident_type,x.description,x.barangay,x.landmark]).toLowerCase().includes(q)))}
function renderViewCounts(){document.querySelectorAll('.view-chip').forEach(chip=>{const key=chip.dataset.view;const count=rows.filter(VIEWS[key]||VIEWS.all).length;const slot=chip.querySelector('[data-count]');if(slot)slot.textContent=String(count);chip.classList.toggle('is-active',key===view)})}
document.querySelectorAll('.view-chip').forEach(chip=>chip.addEventListener('click',()=>{view=chip.dataset.view;renderViewCounts();renderList()}));
let opmap=null;
function renderMap(){
  const host=$('#incidentMap');
  if(!host)return;
  if(!opmap)opmap=createMap(host,{onSelect:id=>open(id)});
  const pins=rows.filter(x=>Number.isFinite(x.latitude)&&Number.isFinite(x.longitude)).map(x=>{
    const where=locationState(x);
    return {
      id:x.id,lat:x.latitude,lon:x.longitude,
      priority:['resolved','closed'].includes(x.status)?'resolved':(x.priority||'unassessed'),
      stale:!where.live,
      /* The accessible name carries reference, mode, type and location state,
         so a pin means the same thing to a screen reader as to an eye. */
      label:`${x.public_reference} · ${(x.report_mode||'emergency')==='assistance'?'Assistance':'Emergency'} · ${pretty(x.incident_type)} · ${where.label} · ${where.detail}`,
    };
  });
  opmap.setMarkers(pins);
  if(active)opmap.select(active.id);
  else opmap.fit();
}

function renderList(){const a=listRows();
  $('#incidentList').innerHTML=a.length?a.map(x=>{
    const mode=(x.report_mode||'emergency')==='assistance';
    const done=['resolved','closed'].includes(x.status);
    /* The mark's colour follows priority once an officer has set one, and
       falls back to a neutral tone while the incident is unassessed. Nothing
       here derives urgency from what the resident chose. */
    const tone=done?'p-resolved':(mode?'mode-assistance':`p-${x.priority||'unassessed'}`);
    const badge=mode?'<span class="badge mode-assistance">ASSISTANCE</span>'
      :`<span class="badge ${esc(x.priority||'unassessed')}">${esc(pretty(x.priority||'unassessed')).toUpperCase()}</span>`;
    return `<button class="incident-row ${active?.id===x.id?'active':''}" data-id="${esc(x.id)}">`+
      `<span class="row-icon ${tone}" aria-hidden="true">${MARK(x)}</span>`+
      `<span class="row-main">`+
        `<span class="row-title">${esc(pretty(x.incident_type))}</span>`+
        `<span class="row-location">${esc([x.barangay,x.landmark].filter(Boolean).join(', ')||'Location in report')}</span>`+
        `<span class="row-time">${esc(clock(x.received_at))}</span>`+
      `</span>`+
      `<span class="row-side">${badge}<span class="row-status">${esc(pretty(x.status))}</span></span>`+
    `</button>`;
  }).join(''):'<div class="empty-list">No incidents match this view.</div>';
  document.querySelectorAll('.incident-row').forEach(b=>b.onclick=()=>open(b.dataset.id))}
['searchInput','statusFilter','priorityFilter'].forEach(id=>$('#'+id).addEventListener(id==='searchInput'?'input':'change',renderList));
async function open(id){active=rows.find(x=>x.id===id);if(!active)return;const [m,e]=await Promise.all([sb.from('emergency_messages').select('*').eq('incident_id',id).order('created_at'),sb.from('emergency_events').select('*').eq('incident_id',id).order('created_at')]);if(m.error||e.error)return note((m.error||e.error).message,true);messages=m.data||[];events=e.data||[];detail();renderList();if(opmap)opmap.focus(active.id)}
function detail(){const x=active,gps=x.latitude!=null&&x.longitude!=null;$('#detailColumn').innerHTML=`<div class="detail"><div class="detail-head"><div><p>${L} INCIDENT</p><h2>${esc(x.public_reference)}</h2><small>Received ${date(x.received_at)}</small></div>${x.status==='received'?'<button class="ack-btn" id="ack">Acknowledge</button>':''}</div><div class="incident-summary"><div class="summary-item"><span>Incident</span><strong>${esc(pretty(x.incident_type))}</strong></div><div class="summary-item"><span>Barangay</span><strong>${esc(x.barangay||'—')}</strong></div><div class="summary-item"><span>Landmark</span><strong>${esc(x.landmark||'—')}</strong></div><div class="summary-item"><span>GPS</span><strong>${gps?`${Number(x.latitude).toFixed(6)}, ${Number(x.longitude).toFixed(6)}`:'Not captured'}</strong></div><div class="summary-item"><span>Accuracy</span><strong>${x.accuracy_m!=null?`±${Math.round(x.accuracy_m)} m`:'—'}</strong></div><div class="summary-item"><span>Contact</span><strong>${esc(x.reporter_contact||'Not provided')}</strong></div></div><div class="description-box"><span>Resident report</span><p>${esc(x.description)}</p></div><div class="ops-controls"><label>Status<select id="st">${['received','acknowledged','assigned','dispatched','en_route','on_scene','resolved','closed'].map(v=>`<option ${x.status===v?'selected':''} value="${v}">${pretty(v)}</option>`).join('')}</select></label><label>Priority<select id="pr">${['unassessed','critical','high','normal'].map(v=>`<option ${x.priority===v?'selected':''} value="${v}">${pretty(v)}</option>`).join('')}</select></label><label>Assigned unit<input id="unit" maxlength="160" value="${esc(x.assigned_unit||'')}"></label></div><div class="ops-buttons"><button id="save">Save operations status</button>${gps?`<a target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(x.latitude+','+x.longitude)}">Open map</a><button id="copy">Copy GPS</button>`:''}<button class="refer" id="refer">Request ${OL} support</button></div><div class="thread-tabs"><button data-mode="public" class="${mode==='public'?'active':''}">Resident chat</button><button data-mode="internal" class="${mode==='internal'?'active':''}">Internal notes</button><button data-mode="timeline" class="${mode==='timeline'?'active':''}">Timeline</button></div><div class="thread" id="thread"></div><form class="reply-form" id="reply"><div class="reply-mode"><label><input type="radio" name="vis" value="public" ${mode!=='internal'?'checked':''}> Public reply</label><label><input type="radio" name="vis" value="internal" ${mode==='internal'?'checked':''}> Internal note</label></div><textarea id="body" rows="3" maxlength="4000"></textarea><div class="reply-actions"><small>Human-operated responder communication.</small><button>Send</button></div></form></div>`;bind(gps);thread()}
function thread(){const box=$('#thread');if(mode==='timeline'){box.innerHTML=events.length?events.map(e=>`<div class="thread-message internal"><strong>${pretty(e.event_type)}</strong><p>${esc(JSON.stringify(e.metadata||{}))}</p><small>${date(e.created_at)}</small></div>`).join(''):'<div class="empty-list">No timeline events yet.</div>';return}const a=messages.filter(m=>m.visibility===mode);box.innerHTML=a.length?a.map(m=>`<div class="thread-message ${mode==='internal'?'internal':m.sender_kind==='resident'?'resident':'agency'}"><strong>${m.sender_kind==='resident'?'Resident':m.sender_kind==='system'?'System':esc(String(m.sender_agency||m.sender_kind).toUpperCase())}</strong><p>${esc(m.body)}</p><small>${date(m.created_at)}</small></div>`).join(''):'<div class="empty-list">No messages yet.</div>';box.scrollTop=box.scrollHeight}
function bind(gps){$('#ack')?.addEventListener('click',()=>patch({status:'acknowledged'}));$('#save').onclick=()=>patch({status:$('#st').value,priority:$('#pr').value,assigned_unit:$('#unit').value.trim()||null});$('#copy')?.addEventListener('click',()=>navigator.clipboard.writeText(`${active.latitude}, ${active.longitude}`).then(()=>note('GPS copied')).catch(()=>note('Copy failed',true)));$('#refer').onclick=async()=>{const {error}=await sb.rpc('emergency_refer_incident',{p_incident_id:active.id,p_agency:OTHER});if(error)return note(error.message,true);note(`${OL} support requested`);await load();await open(active.id)};document.querySelectorAll('[data-mode]').forEach(b=>b.onclick=()=>{mode=b.dataset.mode;detail()});$('#reply').onsubmit=async e=>{e.preventDefault();const body=$('#body').value.trim();if(!body)return;const visibility=document.querySelector('input[name="vis"]:checked').value;const {error}=await sb.from('emergency_messages').insert({incident_id:active.id,sender_kind:A,sender_agency:A,sender_user_id:session.user.id,visibility,body});if(error)return note(error.message,true);mode=visibility;await open(active.id);note(visibility==='public'?'Reply added to resident chat':'Internal note saved')}}
async function patch(v){const id=active.id,{error}=await sb.from('emergency_incidents').update(v).eq('id',id);if(error)return note(error.message,true);await load();await open(id);note('Incident updated')}
window.addEventListener('online',()=>{online();load()});window.addEventListener('offline',online);setInterval(()=>{if(session&&navigator.onLine&&document.visibilityState==='visible')load()},15000);boot().catch(()=>$('#loginMessage').textContent='Could not initialize the console.');


/* --- console rail, filter overflow and view-all ------------------------- */

/* The rail moves the operator around one page. It does not load another
   console: Dashboard is the whole view, Incidents and Map scroll to the
   section that already holds them. Sections without a backend are rendered
   inert in the markup and are not bound here at all. */
document.querySelectorAll('[data-rail]').forEach(button=>{
  button.addEventListener('click',()=>{
    document.querySelectorAll('.rail-item[data-rail]').forEach(b=>b.classList.toggle('is-active',b===button));
    const target={view:'#consoleView',queue:'.incident-column',map:'.map-section'}[button.dataset.rail];
    const node=target&&document.querySelector(target);
    if(node)node.scrollIntoView({behavior:'smooth',block:'start'});
  });
});
$('#railLogout')?.addEventListener('click',async()=>{await sb.auth.signOut();location.reload()});
$('#railToggle')?.addEventListener('click',()=>{
  const rail=$('#consoleRail');const open=rail.classList.toggle('is-open');
  $('#railToggle').setAttribute('aria-expanded',open?'true':'false');
});
$('#moreViews')?.addEventListener('click',()=>{
  const extra=$('#viewExtra');const open=extra.hidden;
  extra.hidden=!open;$('#moreViews').setAttribute('aria-expanded',open?'true':'false');
});
/* "View all" clears the filters rather than opening a different page — there
   is one queue, and this is the view of it with nothing filtered out. */
$('#viewAll')?.addEventListener('click',()=>{
  view='all';$('#searchInput').value='';$('#statusFilter').value='';$('#priorityFilter').value='';
  query='';renderViewCounts();renderList();
  document.querySelector('.incident-column')?.scrollIntoView({behavior:'smooth',block:'start'});
});
