// ===== CONFIGURATION =====
const REPO_OWNER = 'Joshoffie';
const REPO_NAME = 'office-scheduler';
const DATA_FILE = 'data.json';
const BRANCH = 'main';
const HARDCODED_PIN = '1999';
const PRUNE_DAYS = 60; // auto-delete one-time bookings older than this

// ===== GITHUB STORAGE LAYER =====
class GitHubStore {
  constructor(token) {
    this.token = token;
    this.baseUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${DATA_FILE}`;
    this.sha = null;
    this.saving = false;
    this.pendingSave = null;
  }
  headers() {
    return { 'Authorization': `token ${this.token}`, 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json' };
  }
  async load() {
    const res = await fetch(this.baseUrl + `?ref=${BRANCH}&t=${Date.now()}`, { headers: this.headers() });
    if (res.status === 404) { const d = this.defaultData(); await this.saveRaw(d); return d; }
    if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
    const json = await res.json();
    this.sha = json.sha;
    return JSON.parse(atob(json.content.replace(/\n/g, '')));
  }
  async save(data) {
    if (this.saving) { this.pendingSave = data; return; }
    this.saving = true;
    try { await this.saveRaw(data); } finally {
      this.saving = false;
      if (this.pendingSave) { const n = this.pendingSave; this.pendingSave = null; await this.save(n); }
    }
  }
  async saveRaw(data) {
    // Compact JSON (no pretty-print) to minimize file size
    const body = { message: `Update ${new Date().toISOString()}`, content: btoa(unescape(encodeURIComponent(JSON.stringify(data)))), branch: BRANCH };
    if (this.sha) body.sha = this.sha;
    const res = await fetch(this.baseUrl, { method: 'PUT', headers: this.headers(), body: JSON.stringify(body) });
    if (res.status === 409) { await this.load(); return this.saveRaw(data); }
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(`Save: ${res.status} ${e.message||''}`); }
    this.sha = (await res.json()).content.sha;
  }
  defaultData() {
    const floors = [{ id: 'floor-1', name: 'Floor 1', order: 0 }];
    const rooms = [];
    for (let i = 1; i <= 30; i++) rooms.push({ id: `room-${i}`, name: `Room ${i}`, floorId: 'floor-1', order: i - 1 });
    return { floors, rooms, bookings: [], recurringRules: [], knownNames: [] };
  }
}

// ===== AUTO-PRUNE OLD DATA =====
function pruneOldData(data) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - PRUNE_DAYS);
  const cutoffStr = dateStr(cutoff);

  const beforeCount = data.bookings.length;
  // Remove one-time bookings older than PRUNE_DAYS
  data.bookings = data.bookings.filter(b => b.date >= cutoffStr);

  // Prune old exception dates from recurring rules (no need to track exceptions from months ago)
  for (const rule of data.recurringRules) {
    if (rule.exceptions && rule.exceptions.length > 0) {
      rule.exceptions = rule.exceptions.filter(d => d >= cutoffStr);
    }
  }

  const pruned = beforeCount - data.bookings.length;
  if (pruned > 0) console.log(`Pruned ${pruned} bookings older than ${PRUNE_DAYS} days`);
  return pruned > 0;
}

// ===== APP STATE =====
let store = null, data = null;
let currentFloorId = 'floor-1', currentRoomId = null;
let selectedDate = new Date();
let roomViewMode = 'day'; // 'day', 'week', 'month'
let deletingBooking = null, bookingDate = null, nowTimer = null;
let settingsFloorId = null; // which floor is selected in settings for adding rooms

// ===== UTILITY =====
function $(id) { return document.getElementById(id); }
function show(id) { $(id).style.display = ''; }
function hide(id) { $(id).style.display = 'none'; }
function genId() { return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,8); }
function dateStr(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function formatDateShort(d) { const m=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']; return `${m[d.getMonth()]} ${d.getDate()}`; }
function formatDateFull(d) { const dn=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']; const m=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']; return `${dn[d.getDay()]}, ${m[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`; }
function timeToMinutes(t) { const [h,m]=t.split(':').map(Number); return h*60+m; }
function minutesToTime(m) { const h=Math.floor(m/60)%24; return `${String(h).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`; }
function formatTimeDisplay(t) { const [h,m]=t.split(':').map(Number); const ap=h>=12?'PM':'AM'; const h12=h===0?12:h>12?h-12:h; return `${h12}:${String(m).padStart(2,'0')} ${ap}`; }
function toast(msg) { let el=document.querySelector('.toast'); if(!el){el=document.createElement('div');el.className='toast';document.body.appendChild(el);} el.textContent=msg;el.classList.add('show');setTimeout(()=>el.classList.remove('show'),2500); }
function getWeekStart(d) { const dt=new Date(d); dt.setDate(dt.getDate()-dt.getDay()); dt.setHours(0,0,0,0); return dt; }
function addDays(d,n) { const dt=new Date(d); dt.setDate(dt.getDate()+n); return dt; }
function sameDay(a,b) { return a.getFullYear()===b.getFullYear()&&a.getMonth()===b.getMonth()&&a.getDate()===b.getDate(); }
function parseDateStr(s) { const p=s.split('-'); return new Date(p[0],p[1]-1,p[2]); }

// ===== DATA =====
function getBookingsForRoomDate(roomId, date) {
  const ds = dateStr(date), dow = date.getDay(), results = [];
  for (const b of data.bookings) if (b.roomId===roomId && b.date===ds) results.push({...b, isRecurring:false});
  for (const r of data.recurringRules) {
    if (r.roomId===roomId && r.daysOfWeek.includes(dow)) {
      if (!(r.exceptions||[]).includes(ds)) {
        results.push({ id:`${r.id}__${ds}`, ruleId:r.id, roomId:r.roomId, title:r.doctorName,
          details:`Recurring: ${r.daysOfWeek.map(d=>['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d]).join(', ')}`,
          startTime:r.startTime, endTime:r.endTime, date:ds, isRecurring:true });
      }
    }
  }
  return results.sort((a,b)=>timeToMinutes(a.startTime)-timeToMinutes(b.startTime));
}

function getCurrentOccupant(roomId) {
  const now=new Date(), bks=getBookingsForRoomDate(roomId,now), nm=now.getHours()*60+now.getMinutes();
  for (const b of bks) if (timeToMinutes(b.startTime)<=nm && timeToMinutes(b.endTime)>nm) return b;
  return null;
}

// ===== GRID =====
function renderGrid() {
  const grid=$('room-grid'), now=new Date(), nm=now.getHours()*60+now.getMinutes();
  const rooms=data.rooms.filter(r=>r.floorId===currentFloorId).sort((a,b)=>a.order-b.order);
  $('grid-date-display').textContent=formatDateFull(now);
  // Now-line position shifted left a bit (show 2% earlier so you can see recently-ended blocks)
  const nowPct = Math.max(0, (nm / 1440) * 100 - 1);

  grid.innerHTML=rooms.map(room=>{
    const occ=getCurrentOccupant(room.id), bks=getBookingsForRoomDate(room.id,now);
    let mini='';
    for(const b of bks){const s=timeToMinutes(b.startTime),e=timeToMinutes(b.endTime),l=(s/1440)*100,w=((e-s)/1440)*100;
      const cur=s<=nm&&e>nm,fut=s>nm; mini+=`<div class="mini-block${cur?' current':fut?' future':''}" style="left:${l}%;width:${w}%"></div>`;}
    // Add now-line to mini timeline
    mini += `<div class="mini-now-line" style="left:${nowPct}%"></div>`;
    return `<div class="room-card ${occ?'occupied':'available'}" data-room-id="${room.id}">
      <div class="room-card-header"><span class="room-card-name">${room.name}</span>
        <span class="room-card-status ${occ?'status-occupied':'status-available'}">${occ?'IN USE':'Open'}</span></div>
      <div class="room-card-occupant">${occ?occ.title:''}</div>
      <div class="mini-timeline">${mini}</div></div>`;
  }).join('');
  grid.querySelectorAll('.room-card').forEach(c=>c.addEventListener('click',()=>openRoom(c.dataset.roomId)));
}

function renderFloorTabs() {
  const tabs=$('floor-tabs');
  tabs.innerHTML=data.floors.sort((a,b)=>a.order-b.order).map(f=>`<button class="floor-tab ${f.id===currentFloorId?'active':''}" data-floor-id="${f.id}">${f.name}</button>`).join('');
  tabs.querySelectorAll('.floor-tab').forEach(b=>b.addEventListener('click',()=>{currentFloorId=b.dataset.floorId;renderFloorTabs();renderGrid();}));
}

// ===== ROOM VIEW =====
function openRoom(roomId) {
  currentRoomId=roomId; selectedDate=new Date(); roomViewMode='day';
  hide('grid-view'); show('room-view'); renderRoom();
}

function renderRoom() {
  const room=data.rooms.find(r=>r.id===currentRoomId); if(!room) return;
  $('room-title').textContent=room.name;
  document.querySelectorAll('.view-toggle-btn').forEach(b=>b.classList.toggle('active',b.dataset.view===roomViewMode));
  if(roomViewMode==='day') renderDayView();
  else if(roomViewMode==='week') renderWeekView();
  else renderMonthView();
}

// ===== DAY VIEW =====
function renderDayView() {
  const container=$('calendar-container'), today=new Date();
  $('room-date-display').textContent=formatDateFull(selectedDate);

  let timeHTML='';
  for(let h=0;h<24;h++){const ap=h>=12?'PM':'AM',h12=h===0?12:h>12?h-12:h; timeHTML+=`<div class="time-label">${h12} ${ap}</div>`;}

  let hourLines='';
  for(let h=0;h<24;h++) hourLines+=`<div class="hour-line" style="top:${h*60}px"></div>`;

  // Now line
  let nowLineHTML='';
  if(sameDay(selectedDate,today)){const nm=today.getHours()*60+today.getMinutes(); nowLineHTML=`<div class="now-line" style="top:${nm}px"><div class="now-dot"></div></div>`;}

  const bookings=getBookingsForRoomDate(currentRoomId,selectedDate);
  let evHTML='';
  for(const b of bookings){
    const sm=timeToMinutes(b.startTime),em=timeToMinutes(b.endTime),h=Math.max(em-sm,15);
    evHTML+=`<div class="event-block${b.isRecurring?' recurring':''}" style="top:${sm}px;height:${h}px" data-booking='${JSON.stringify(b).replace(/'/g,"&#39;")}'>
      <div class="event-title">${b.title}</div>
      <div class="event-time">${formatTimeDisplay(b.startTime)} – ${formatTimeDisplay(b.endTime)}</div>
      ${b.details?`<div class="event-details">${b.isRecurring?'Recurring office':b.details}</div>`:''}
    </div>`;
  }

  container.innerHTML=`<div class="day-view"><div class="time-column">${timeHTML}</div><div class="events-column" id="day-events-col">${hourLines}${nowLineHTML}${evHTML}</div></div>`;

  // Scroll
  if(sameDay(selectedDate,today)) container.scrollTop=Math.max(0,today.getHours()*60-60); else container.scrollTop=7*60;

  // Click events
  container.querySelectorAll('.event-block').forEach(el=>{el.addEventListener('click',e=>{e.stopPropagation();showDeleteModal(JSON.parse(el.dataset.booking));});});
  const evCol=container.querySelector('.events-column');
  if(evCol) evCol.addEventListener('dblclick',e=>{if(e.target.closest('.event-block'))return;const y=e.clientY-evCol.getBoundingClientRect().top+container.scrollTop;bookingDate=dateStr(selectedDate);openBookingModal(Math.round(y/15)*15);});
}

// ===== WEEK VIEW =====
function renderWeekView() {
  const container=$('calendar-container'), ws=getWeekStart(selectedDate), we=addDays(ws,6), today=new Date();
  const mo=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  $('room-date-display').textContent=ws.getMonth()===we.getMonth()?`${mo[ws.getMonth()]} ${ws.getDate()} – ${we.getDate()}, ${ws.getFullYear()}`:`${formatDateShort(ws)} – ${formatDateShort(we)}, ${we.getFullYear()}`;

  let hdr='<div class="week-header-corner"></div>';
  const dn=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  for(let i=0;i<7;i++){const d=addDays(ws,i),isT=sameDay(d,today); hdr+=`<div class="week-header-cell${isT?' today':''}">${dn[d.getDay()]}<span class="day-num">${d.getDate()}</span></div>`;}

  let timeHTML='';
  for(let h=0;h<24;h++){const ap=h>=12?'PM':'AM',h12=h===0?12:h>12?h-12:h; timeHTML+=`<div class="week-time-label">${h12} ${ap}</div>`;}

  let cols='';
  for(let i=0;i<7;i++){
    const d=addDays(ws,i),ds=dateStr(d),bks=getBookingsForRoomDate(currentRoomId,d);
    let lines=''; for(let h=0;h<24;h++) lines+=`<div class="week-hour-line" style="top:${h*60}px"></div>`;
    // Now line in week
    let nl=''; if(sameDay(d,today)){const nm=today.getHours()*60+today.getMinutes(); nl=`<div class="now-line" style="top:${nm}px"><div class="now-dot"></div></div>`;}
    let ev=''; for(const b of bks){const sm=timeToMinutes(b.startTime),em=timeToMinutes(b.endTime),h=Math.max(em-sm,15);
      ev+=`<div class="week-event${b.isRecurring?' recurring':''}" style="top:${sm}px;height:${h}px" data-booking='${JSON.stringify(b).replace(/'/g,"&#39;")}'><div class="week-event-title">${b.title}</div>${h>=30?`<div class="week-event-time">${formatTimeDisplay(b.startTime)}</div>`:''}</div>`;}
    cols+=`<div class="week-day-col" data-date="${ds}">${lines}${nl}${ev}</div>`;
  }

  container.innerHTML=`<div class="week-view"><div class="week-header">${hdr}</div><div class="week-body" id="week-body"><div class="week-time-col">${timeHTML}</div>${cols}</div></div>`;
  const body=$('week-body'); if(body){if(sameDay(selectedDate,today))body.scrollTop=Math.max(0,today.getHours()*60-60);else body.scrollTop=7*60;}
  container.querySelectorAll('.week-event').forEach(el=>{el.addEventListener('click',e=>{e.stopPropagation();showDeleteModal(JSON.parse(el.dataset.booking));});});
  container.querySelectorAll('.week-day-col').forEach(col=>{col.addEventListener('dblclick',e=>{if(e.target.closest('.week-event'))return;const y=e.clientY-col.getBoundingClientRect().top+col.parentElement.scrollTop;bookingDate=col.dataset.date;openBookingModal(Math.round(y/15)*15);});});
}

// ===== MONTH VIEW =====
function renderMonthView() {
  const container=$('calendar-container'), today=new Date(), yr=selectedDate.getFullYear(), mo=selectedDate.getMonth();
  const moNames=['January','February','March','April','May','June','July','August','September','October','November','December'];
  $('room-date-display').textContent=`${moNames[mo]} ${yr}`;
  const firstDay=new Date(yr,mo,1), startDay=getWeekStart(firstDay), lastDay=new Date(yr,mo+1,0), endDay=addDays(lastDay,6-lastDay.getDay());
  const dn=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  let hdr=dn.map(d=>`<div class="month-header-cell">${d}</div>`).join('');
  let days='', cursor=new Date(startDay);
  while(cursor<=endDay){
    const d=new Date(cursor), ds=dateStr(d), other=d.getMonth()!==mo, isT=sameDay(d,today), bks=getBookingsForRoomDate(currentRoomId,d);
    let pips=''; const mx=3;
    for(let i=0;i<Math.min(bks.length,mx);i++){const b=bks[i]; pips+=`<div class="month-event-pip ${b.isRecurring?'recurring':'booking'}">${formatTimeDisplay(b.startTime)} ${b.title}</div>`;}
    if(bks.length>mx) pips+=`<div class="month-event-more">+${bks.length-mx} more</div>`;
    days+=`<div class="month-day${other?' other-month':''}${isT?' today':''}" data-date="${ds}"><div class="month-day-num">${d.getDate()}</div>${pips}</div>`;
    cursor=addDays(cursor,1);
  }
  container.innerHTML=`<div class="month-view"><div class="month-grid">${hdr}${days}</div></div>`;
  container.querySelectorAll('.month-day').forEach(cell=>{cell.addEventListener('dblclick',()=>{bookingDate=cell.dataset.date;openBookingModal(480);});});
  container.querySelectorAll('.month-event-pip').forEach(pip=>{pip.addEventListener('click',e=>{e.stopPropagation();const cell=pip.closest('.month-day'),d=parseDateStr(cell.dataset.date),bks=getBookingsForRoomDate(currentRoomId,d),t=pip.textContent.trim();for(const b of bks)if(t.includes(b.title)){showDeleteModal(b);return;}});});
}

// ===== TIME INPUT (split hour / minute / ampm) =====
function initTimeInput(containerId, hiddenId) {
  const container = $(containerId), hidden = $(hiddenId);
  const parts = container.querySelectorAll('.time-part');
  const hourEl = container.querySelector('[data-part="hour"]');
  const minEl = container.querySelector('[data-part="minute"]');
  const ampmEl = container.querySelector('[data-part="ampm"]');

  function getMins() { return timeToMinutes(hidden.value); }

  function setMins(m) {
    m = ((m % 1440) + 1440) % 1440;
    m = Math.round(m / 15) * 15;
    if (m >= 1440) m = 1425;
    hidden.value = minutesToTime(m);
    syncDisplay();
  }

  function syncDisplay() {
    const m = getMins();
    const h24 = Math.floor(m / 60);
    const min = m % 60;
    const h12 = h24 === 0 ? 12 : h24 > 12 ? h24 - 12 : h24;
    const ap = h24 >= 12 ? 'PM' : 'AM';
    hourEl.textContent = h12;
    minEl.textContent = String(min).padStart(2, '0');
    ampmEl.textContent = ap;
  }

  // Drag on hour: 1 hour per ~30px drag
  function setupDrag(el, part) {
    let startY = 0, startVal = 0, dragging = false;

    el.addEventListener('mousedown', e => {
      if (el.querySelector('input')) return; // editing mode
      e.preventDefault();
      dragging = true; startY = e.clientY; startVal = getMins();
      el.classList.add('dragging');

      function onMove(e2) {
        const dy = startY - e2.clientY;
        if (part === 'hour') {
          const delta = Math.round(dy / 30) * 60;
          setMins(startVal + delta);
        } else {
          const delta = Math.round(dy / 20) * 15;
          setMins(startVal + delta);
        }
      }
      function onUp() {
        dragging = false; el.classList.remove('dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    // Touch drag
    el.addEventListener('touchstart', e => {
      if (el.querySelector('input')) return;
      startY = e.touches[0].clientY; startVal = getMins();
      el.classList.add('dragging');
    }, { passive: true });
    el.addEventListener('touchmove', e => {
      e.preventDefault();
      const dy = startY - e.touches[0].clientY;
      if (part === 'hour') setMins(startVal + Math.round(dy / 30) * 60);
      else setMins(startVal + Math.round(dy / 20) * 15);
    }, { passive: false });
    el.addEventListener('touchend', () => { el.classList.remove('dragging'); });

    // Scroll wheel
    el.addEventListener('wheel', e => {
      e.preventDefault();
      const dir = e.deltaY < 0 ? 1 : -1;
      if (part === 'hour') setMins(getMins() + dir * 60);
      else setMins(getMins() + dir * 15);
    }, { passive: false });
  }

  // Click to type
  function setupClickEdit(el, part) {
    el.addEventListener('click', e => {
      if (el.querySelector('input')) return;
      el.classList.add('editing');
      const curVal = el.textContent;
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.value = curVal;
      inp.maxLength = 2;
      el.textContent = '';
      el.appendChild(inp);
      inp.focus();
      inp.select();

      function commit() {
        const v = parseInt(inp.value, 10);
        el.classList.remove('editing');
        if (part === 'hour' && v >= 1 && v <= 12) {
          const m = getMins();
          const currentH24 = Math.floor(m / 60);
          const isPM = currentH24 >= 12;
          let h24 = v === 12 ? 0 : v;
          if (isPM) h24 += 12;
          setMins(h24 * 60 + (m % 60));
        } else if (part === 'minute' && v >= 0 && v <= 59) {
          const m = getMins();
          setMins(Math.floor(m / 60) * 60 + Math.round(v / 15) * 15);
        } else {
          syncDisplay(); // revert
        }
      }
      inp.addEventListener('blur', commit);
      inp.addEventListener('keydown', e2 => {
        if (e2.key === 'Enter') { e2.preventDefault(); inp.blur(); }
        if (e2.key === 'Escape') { el.classList.remove('editing'); syncDisplay(); }
      });
    });
  }

  // AM/PM toggle on click
  ampmEl.addEventListener('click', () => {
    const m = getMins();
    if (m >= 720) setMins(m - 720); else setMins(m + 720);
  });
  ampmEl.addEventListener('wheel', e => {
    e.preventDefault();
    const m = getMins();
    if (m >= 720) setMins(m - 720); else setMins(m + 720);
  }, { passive: false });

  setupDrag(hourEl, 'hour');
  setupDrag(minEl, 'minute');
  setupClickEdit(hourEl, 'hour');
  setupClickEdit(minEl, 'minute');

  return { setMins, getMins, syncDisplay };
}

let startInput, endInput;

// ===== AUTOCOMPLETE =====
function getKnownNames() {
  const names = new Set(data.knownNames || []);
  for (const b of data.bookings) names.add(b.title);
  for (const r of data.recurringRules) names.add(r.doctorName);
  return [...names].filter(Boolean).sort();
}

let acIndex = -1;
function setupAutocomplete() {
  const input = $('booking-title'), dropdown = $('autocomplete-dropdown');
  let items = [];

  function render(matches) {
    if (matches.length === 0) { dropdown.style.display = 'none'; acIndex = -1; return; }
    items = matches;
    dropdown.innerHTML = matches.map((m, i) => `<div class="autocomplete-item${i===acIndex?' active':''}" data-idx="${i}">${m}</div>`).join('')
      + '<div class="autocomplete-hint">Tab to select</div>';
    dropdown.style.display = '';
  }

  input.addEventListener('input', () => {
    const val = input.value.trim().toLowerCase();
    if (!val) { dropdown.style.display = 'none'; return; }
    const matches = getKnownNames().filter(n => n.toLowerCase().includes(val));
    acIndex = matches.length > 0 ? 0 : -1;
    render(matches);
  });

  input.addEventListener('keydown', e => {
    if (dropdown.style.display === 'none' || items.length === 0) return;
    if (e.key === 'Tab' || e.key === 'Enter') {
      if (acIndex >= 0 && acIndex < items.length) { e.preventDefault(); input.value = items[acIndex]; dropdown.style.display = 'none'; }
    } else if (e.key === 'ArrowDown') { e.preventDefault(); acIndex = Math.min(acIndex + 1, items.length - 1); render(items); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); acIndex = Math.max(acIndex - 1, 0); render(items); }
    else if (e.key === 'Escape') { dropdown.style.display = 'none'; }
  });

  dropdown.addEventListener('click', e => {
    const item = e.target.closest('.autocomplete-item');
    if (item) { input.value = items[Number(item.dataset.idx)]; dropdown.style.display = 'none'; input.focus(); }
  });

  input.addEventListener('blur', () => { setTimeout(() => { dropdown.style.display = 'none'; }, 200); });
}

// ===== BOOKING MODAL =====
function openBookingModal(startMinutes) {
  $('modal-title').textContent='New Booking';
  $('booking-title').value=''; $('booking-details').value='';
  startInput.setMins(startMinutes||480); endInput.setMins((startMinutes||480)+60);
  $('booking-recurring').checked=false; hide('recurring-options');
  $('booking-recurring-btn').classList.remove('active');
  $('recurring-doctor').value='';
  document.querySelectorAll('.day-btn').forEach(b=>b.classList.remove('selected'));
  $('autocomplete-dropdown').style.display='none';
  show('booking-modal'); $('booking-title').focus();
}
function closeBookingModal() { hide('booking-modal'); bookingDate=null; }

async function saveBooking() {
  const title=$('booking-title').value.trim(), details=$('booking-details').value.trim();
  const startTime=$('booking-start').value, endTime=$('booking-end').value;
  const isRecurring=$('booking-recurring').checked;
  if(!title){toast('Please enter a title');return;} if(!startTime||!endTime){toast('Please set times');return;}
  if(timeToMinutes(endTime)<=timeToMinutes(startTime)){toast('End time must be after start time');return;}

  // Save name to known names
  if(!data.knownNames) data.knownNames=[];
  if(!data.knownNames.includes(title)) data.knownNames.push(title);

  if(isRecurring){
    const doc=$('recurring-doctor').value.trim(), days=[...document.querySelectorAll('.day-btn.selected')].map(b=>Number(b.dataset.day));
    if(!doc){toast('Enter doctor name');return;} if(!days.length){toast('Select days');return;}
    if(!data.knownNames.includes(doc)) data.knownNames.push(doc);
    data.recurringRules.push({id:genId(),roomId:currentRoomId,doctorName:doc,daysOfWeek:days,startTime,endTime,exceptions:[],createdAt:new Date().toISOString()});
  } else {
    data.bookings.push({id:genId(),roomId:currentRoomId,title,details,date:bookingDate||dateStr(selectedDate),startTime,endTime,createdAt:new Date().toISOString()});
  }
  closeBookingModal(); renderRoom(); toast('Booking saved');
  try{await store.save(data);}catch(e){toast('Error saving');console.error(e);}
}

// ===== DELETE =====
function showDeleteModal(booking) { deletingBooking=booking; $('delete-confirm-text').textContent=`Delete "${booking.title}"?`; if(booking.isRecurring)show('delete-recurring-options');else hide('delete-recurring-options'); show('delete-modal'); }
function closeDeleteModal() { hide('delete-modal'); deletingBooking=null; }
async function confirmDelete() {
  if(!deletingBooking)return;
  if(deletingBooking.isRecurring){const scope=document.querySelector('input[name="delete-scope"]:checked').value;const rule=data.recurringRules.find(r=>r.id===deletingBooking.ruleId);
    if(rule){if(scope==='all')data.recurringRules=data.recurringRules.filter(r=>r.id!==deletingBooking.ruleId);else{if(!rule.exceptions)rule.exceptions=[];rule.exceptions.push(deletingBooking.date);}}}
  else data.bookings=data.bookings.filter(b=>b.id!==deletingBooking.id);
  closeDeleteModal();renderRoom();toast('Deleted');try{await store.save(data);}catch(e){toast('Error saving');console.error(e);}
}

// ===== SETTINGS =====
function openSettings() {
  settingsFloorId = currentFloorId;
  renderSettingsFloors(); renderSettingsFloorPicker(); renderSettingsRooms();
  show('settings-modal');
}
function closeSettings() { hide('settings-modal'); }

function renderSettingsFloors() {
  const list=$('floor-list');
  list.innerHTML=data.floors.sort((a,b)=>a.order-b.order).map(f=>`<div class="settings-item"><input type="text" value="${f.name}" data-id="${f.id}">${data.floors.length>1?`<button class="delete-btn" data-id="${f.id}">&times;</button>`:''}</div>`).join('');
  list.querySelectorAll('input').forEach(inp=>{inp.addEventListener('change',async()=>{const fl=data.floors.find(f=>f.id===inp.dataset.id);if(fl)fl.name=inp.value.trim();renderFloorTabs();renderSettingsFloorPicker();await store.save(data);});});
  list.querySelectorAll('.delete-btn').forEach(btn=>{btn.addEventListener('click',async()=>{if(!confirm('Delete this floor and all its rooms?'))return;const id=btn.dataset.id;data.floors=data.floors.filter(f=>f.id!==id);data.rooms=data.rooms.filter(r=>r.floorId!==id);data.bookings=data.bookings.filter(b=>data.rooms.some(r=>r.id===b.roomId));data.recurringRules=data.recurringRules.filter(r=>data.rooms.some(rm=>rm.id===r.roomId));if(currentFloorId===id)currentFloorId=data.floors[0]?.id||'';if(settingsFloorId===id)settingsFloorId=data.floors[0]?.id||'';renderSettingsFloors();renderSettingsFloorPicker();renderSettingsRooms();renderFloorTabs();renderGrid();await store.save(data);});});
}

function renderSettingsFloorPicker() {
  const picker = $('settings-floor-picker');
  picker.innerHTML = data.floors.sort((a,b)=>a.order-b.order).map(f =>
    `<button class="settings-floor-pick-btn ${f.id===settingsFloorId?'active':''}" data-fid="${f.id}">${f.name}</button>`
  ).join('');
  $('settings-floor-name').textContent = data.floors.find(f=>f.id===settingsFloorId)?.name || '';
  picker.querySelectorAll('.settings-floor-pick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      settingsFloorId = btn.dataset.fid;
      renderSettingsFloorPicker();
      renderSettingsRooms();
    });
  });
}

function renderSettingsRooms() {
  const list=$('room-list'), rooms=data.rooms.filter(r=>r.floorId===settingsFloorId).sort((a,b)=>a.order-b.order);
  list.innerHTML=rooms.map(r=>`<div class="settings-item"><input type="text" value="${r.name}" data-id="${r.id}"><button class="delete-btn" data-id="${r.id}">&times;</button></div>`).join('');
  list.querySelectorAll('input').forEach(inp=>{inp.addEventListener('change',async()=>{const rm=data.rooms.find(r=>r.id===inp.dataset.id);if(rm)rm.name=inp.value.trim();renderGrid();await store.save(data);});});
  list.querySelectorAll('.delete-btn').forEach(btn=>{btn.addEventListener('click',async()=>{const id=btn.dataset.id;data.rooms=data.rooms.filter(r=>r.id!==id);data.bookings=data.bookings.filter(b=>b.roomId!==id);data.recurringRules=data.recurringRules.filter(r=>r.roomId!==id);renderSettingsRooms();renderGrid();await store.save(data);});});
}

// ===== NAV =====
function showSetup(){hide('pin-view');hide('grid-view');hide('room-view');show('setup-view');}
function showPin(){hide('setup-view');hide('grid-view');hide('room-view');show('pin-view');$('pin-input').focus();}
function showGrid(){hide('setup-view');hide('pin-view');hide('room-view');show('grid-view');renderFloorTabs();renderGrid();startNowTimer();startAutoSync();}
function startNowTimer(){if(nowTimer)clearInterval(nowTimer);nowTimer=setInterval(()=>{if($('grid-view').style.display!=='none')renderGrid();},60000);}

// Auto-sync every 30 seconds
let autoSyncTimer=null;
function startAutoSync(){
  if(autoSyncTimer)clearInterval(autoSyncTimer);
  autoSyncTimer=setInterval(async()=>{
    if(!store)return;
    try{
      data=await store.load();
      pruneOldData(data); // lightweight check, only saves if something was pruned
      if($('grid-view').style.display!=='none')renderGrid();
      if($('room-view').style.display!=='none')renderRoom();
    }catch(e){console.warn('Auto-sync failed:',e);}
  },30000);
}

// ===== INIT =====
async function init() {
  const token=localStorage.getItem('gh_token');
  if(!token){showSetup();return;}
  store=new GitHubStore(token);
  try{data=await store.load();}catch(e){console.error(e);toast('Failed to connect');showSetup();return;}
  // Auto-prune old bookings on startup
  if(pruneOldData(data)){try{await store.save(data);console.log('Pruned data saved');}catch(e){console.warn('Prune save failed:',e);}}
  const session=sessionStorage.getItem('pin_ok');
  if(session==='true'){showGrid();}else{showPin();}
}

// ===== EVENTS =====
document.addEventListener('DOMContentLoaded',()=>{
  // Init time inputs (new split hour/min/ampm)
  startInput=initTimeInput('start-time-input','booking-start');
  endInput=initTimeInput('end-time-input','booking-end');
  setupAutocomplete();

  // Setup (token only, no PIN setup)
  $('setup-save-btn').addEventListener('click',async()=>{
    const token=$('github-token-input').value.trim();
    const existingToken=localStorage.getItem('gh_token')||token;
    if(!existingToken){$('setup-error').textContent='Please enter a GitHub token.';return;}
    $('setup-error').textContent='';$('setup-save-btn').textContent='Connecting...';$('setup-save-btn').disabled=true;
    try{localStorage.setItem('gh_token',existingToken);store=new GitHubStore(existingToken);data=await store.load();
      sessionStorage.setItem('pin_ok','true');showGrid();toast('Setup complete!');}
    catch(e){console.error(e);$('setup-error').textContent='Failed to connect.';localStorage.removeItem('gh_token');}
    finally{$('setup-save-btn').textContent='Complete Setup';$('setup-save-btn').disabled=false;}
  });

  // PIN (hardcoded)
  $('pin-submit-btn').addEventListener('click',()=>{if($('pin-input').value.trim()===HARDCODED_PIN){sessionStorage.setItem('pin_ok','true');$('pin-error').textContent='';showGrid();}else $('pin-error').textContent='Incorrect PIN.';});
  $('pin-input').addEventListener('keydown',e=>{if(e.key==='Enter')$('pin-submit-btn').click();});

  // Back
  $('back-btn').addEventListener('click',()=>{currentRoomId=null;hide('room-view');showGrid();});

  // Nav arrows
  $('prev-btn').addEventListener('click',()=>{
    if(roomViewMode==='day') selectedDate=addDays(selectedDate,-1);
    else if(roomViewMode==='week') selectedDate=addDays(selectedDate,-7);
    else selectedDate=new Date(selectedDate.getFullYear(),selectedDate.getMonth()-1,1);
    renderRoom();
  });
  $('next-btn').addEventListener('click',()=>{
    if(roomViewMode==='day') selectedDate=addDays(selectedDate,1);
    else if(roomViewMode==='week') selectedDate=addDays(selectedDate,7);
    else selectedDate=new Date(selectedDate.getFullYear(),selectedDate.getMonth()+1,1);
    renderRoom();
  });
  $('today-btn').addEventListener('click',()=>{selectedDate=new Date();renderRoom();});

  // View toggle
  $('view-toggle').addEventListener('click',e=>{const b=e.target.closest('.view-toggle-btn');if(!b)return;roomViewMode=b.dataset.view;renderRoom();});

  // Add booking
  $('add-booking-btn').addEventListener('click',()=>{const now=new Date();bookingDate=dateStr(selectedDate);openBookingModal(Math.ceil((now.getHours()*60+now.getMinutes())/15)*15);});

  // Booking modal
  $('modal-close-btn').addEventListener('click',closeBookingModal);
  $('modal-cancel-btn').addEventListener('click',closeBookingModal);
  $('modal-save-btn').addEventListener('click',saveBooking);

  // Recurring button toggles the hidden checkbox + options
  $('booking-recurring-btn').addEventListener('click',()=>{
    const cb=$('booking-recurring'), btn=$('booking-recurring-btn');
    cb.checked=!cb.checked;
    btn.classList.toggle('active',cb.checked);
    if(cb.checked){show('recurring-options');$('booking-title').placeholder='Auto-filled from doctor name';}
    else{hide('recurring-options');$('booking-title').placeholder='e.g., Dr. Smith';}
  });
  $('recurring-doctor').addEventListener('input',()=>{if($('booking-recurring').checked)$('booking-title').value=$('recurring-doctor').value;});
  document.querySelectorAll('.day-btn').forEach(b=>{b.addEventListener('click',e=>{e.preventDefault();b.classList.toggle('selected');});});

  // Enter key saves booking unless details textarea is focused
  document.addEventListener('keydown',e=>{
    if(e.key==='Enter' && $('booking-modal').style.display!=='none'){
      const active=document.activeElement;
      // Don't trigger if typing in details textarea or autocomplete is showing
      if(active && active.id==='booking-details') return;
      if($('autocomplete-dropdown').style.display!=='none') return;
      // Don't trigger if inside a time-part input
      if(active && active.closest && active.closest('.time-part')) return;
      e.preventDefault();
      saveBooking();
    }
  });

  // Delete
  $('delete-modal-close').addEventListener('click',closeDeleteModal);
  $('delete-cancel-btn').addEventListener('click',closeDeleteModal);
  $('delete-confirm-btn').addEventListener('click',confirmDelete);

  // Sync
  async function syncData(btn){btn.style.animation='spin 0.6s linear infinite';try{data=await store.load();if($('grid-view').style.display!=='none')renderGrid();if($('room-view').style.display!=='none')renderRoom();toast('Synced!');}catch(e){toast('Sync failed');console.error(e);}finally{btn.style.animation='';}}
  $('sync-btn').addEventListener('click',()=>syncData($('sync-btn')));
  $('room-sync-btn').addEventListener('click',()=>syncData($('room-sync-btn')));

  // Settings
  $('settings-btn').addEventListener('click',openSettings);
  $('settings-close-btn').addEventListener('click',()=>{closeSettings();renderGrid();});
  $('add-floor-btn').addEventListener('click',async()=>{const mx=Math.max(0,...data.floors.map(f=>f.order));data.floors.push({id:genId(),name:`Floor ${data.floors.length+1}`,order:mx+1});renderSettingsFloors();renderSettingsFloorPicker();renderFloorTabs();await store.save(data);});
  $('add-room-btn').addEventListener('click',async()=>{const fRooms=data.rooms.filter(r=>r.floorId===settingsFloorId);const mx=Math.max(0,...fRooms.map(r=>r.order));data.rooms.push({id:genId(),name:`Room ${fRooms.length+1}`,floorId:settingsFloorId,order:mx+1});renderSettingsRooms();renderGrid();await store.save(data);});
  $('reset-config-btn').addEventListener('click',()=>{if(!confirm('Clear GitHub token?'))return;localStorage.removeItem('gh_token');sessionStorage.removeItem('pin_ok');location.reload();});

  // Close modals on overlay
  document.querySelectorAll('.modal-overlay').forEach(o=>{o.addEventListener('click',e=>{if(e.target===o)o.style.display='none';});});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){if($('booking-modal').style.display!=='none')closeBookingModal();if($('delete-modal').style.display!=='none')closeDeleteModal();if($('settings-modal').style.display!=='none'){closeSettings();renderGrid();}}});

  init();
});
