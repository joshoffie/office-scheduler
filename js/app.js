// ===== CONFIGURATION =====
const REPO_OWNER = 'Joshoffie';
const REPO_NAME = 'office-scheduler';
const DATA_FILE = 'data.json';
const BRANCH = 'main';
const HARDCODED_PIN = '1999';
const PRUNE_DAYS = 60; // default: auto-delete one-time bookings older than this
const MAX_JSON_BYTES = 800000; // 800KB safety limit (GitHub API max is 1MB)
const PRUNE_TIERS = [60, 30, 14, 7, 3]; // progressively aggressive pruning thresholds

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
    if (demoMode) return;
    if (this.saving) { this.pendingSave = data; return; }
    this.saving = true;
    try {
      // Pre-save size guard: adaptive prune if approaching limit
      pruneOldData(data);
      await this.saveRaw(data);
    } finally {
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

// ===== AUTO-PRUNE OLD DATA (adaptive) =====
function pruneAtDays(data, days) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = dateStr(cutoff);
  const before = data.bookings.length;
  data.bookings = data.bookings.filter(b => b.date >= cutoffStr);
  for (const rule of data.recurringRules) {
    if (rule.exceptions && rule.exceptions.length > 0) {
      rule.exceptions = rule.exceptions.filter(d => d >= cutoffStr);
    }
  }
  return before - data.bookings.length;
}

function dataSize(data) {
  return new Blob([JSON.stringify(data)]).size;
}

function pruneOldData(data) {
  let totalPruned = 0;

  // First pass: standard prune at default threshold
  totalPruned += pruneAtDays(data, PRUNE_DAYS);

  // Adaptive: if still too big, progressively prune harder
  let size = dataSize(data);
  for (const tier of PRUNE_TIERS) {
    if (size <= MAX_JSON_BYTES) break;
    const p = pruneAtDays(data, tier);
    totalPruned += p;
    if (p > 0) {
      size = dataSize(data);
      console.warn(`Storage pressure: pruned to ${tier} days (${(size/1024).toFixed(0)}KB)`);
    }
  }

  // Nuclear option: if STILL too big (tons of recurring rules or rooms), trim knownNames
  if (size > MAX_JSON_BYTES && data.knownNames && data.knownNames.length > 50) {
    data.knownNames = data.knownNames.slice(-50);
    size = dataSize(data);
    console.warn(`Trimmed knownNames to 50 (${(size/1024).toFixed(0)}KB)`);
  }

  if (totalPruned > 0) console.log(`Pruned ${totalPruned} old bookings`);
  if (size > MAX_JSON_BYTES) console.error(`WARNING: data.json is ${(size/1024).toFixed(0)}KB — approaching GitHub 1MB limit!`);
  return totalPruned > 0;
}

// ===== APP STATE =====
let store = null, data = null;
let currentFloorId = 'floor-1', currentRoomId = null;
let selectedDate = new Date();
let roomViewMode = 'day'; // 'day', 'week', 'month'
let deletingBooking = null, bookingDate = null, nowTimer = null;
let settingsFloorId = null; // which floor is selected in settings for adding rooms
let editingBookingId = null; // tracks which booking is being edited in inline panel
let demoMode = false, originalData = null, tourStep = 0, tourSteps = [];

// ===== UTILITY =====
function $(id) { return document.getElementById(id); }
function show(id) { $(id).style.display = ''; }
function hide(id) { $(id).style.display = 'none'; }
function transitionViews(outId, inId, onMid) {
  const outEl = $(outId), inEl = $(inId);
  outEl.classList.add('view-container','view-fade-out');
  setTimeout(() => {
    outEl.style.display = 'none';
    outEl.classList.remove('view-fade-out','view-container');
    if (onMid) onMid();
    inEl.style.display = '';
    inEl.classList.add('view-container','view-fade-in');
    void inEl.offsetWidth;
    inEl.classList.add('view-active');
    setTimeout(() => {
      inEl.classList.remove('view-container','view-fade-in','view-active');
    }, 260);
  }, 200);
}
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

// ===== DEMO DATA =====
const DEMO_DOCTORS = [
  'Dr. Sarah Chen', 'Dr. Michael Rivera', 'Dr. Emily Watson', 'Dr. James Okafor',
  'Dr. Lisa Patel', 'Dr. Robert Kim', 'Dr. Amanda Foster', 'Dr. David Nguyen',
  'Dr. Rachel Torres', 'Dr. Kevin Murphy', 'Dr. Natalie Brooks', 'Dr. Andrew Shah',
  'Dr. Jennifer Lee', 'Dr. Marcus Grant', 'Dr. Sofia Ramirez', 'Dr. Thomas Wright'
];
const DEMO_DETAILS = [
  'Annual checkup', 'Follow-up visit', 'New patient consultation', 'Lab review',
  'Physical therapy', 'Post-op check', 'Medication review', 'Urgent care',
  'Wellness exam', 'Referral consult', 'Imaging review', 'Pre-surgical eval',
  'Allergy testing', 'Vaccination', 'Blood work', 'Skin check'
];

// ===== COLOR PALETTE =====
const COLORS = [
  '#3B82F6','#2563EB','#1D4ED8', // blues
  '#06B6D4','#0891B2','#0E7490', // cyan
  '#8B5CF6','#7C3AED','#6D28D9', // purple
  '#EC4899','#DB2777','#BE185D', // pink
  '#EF4444','#DC2626','#B91C1C', // red
  '#F97316','#EA580C','#C2410C', // orange
  '#F59E0B','#D97706','#B45309', // amber
  '#22C55E','#16A34A','#15803D', // green
  '#14B8A6','#0D9488','#0F766E', // teal
  '#6366F1','#4F46E5','#4338CA', // indigo
  '#A855F7','#9333EA','#7E22CE', // violet
  '#64748B','#475569','#334155', // slate
];

function initColorPicker(containerId, hiddenId) {
  const container = $(containerId), hidden = $(hiddenId);
  container.innerHTML = COLORS.map(c =>
    `<div class="color-swatch${c===hidden.value?' selected':''}" data-color="${c}" style="background:${c}"></div>`
  ).join('');
  container.querySelectorAll('.color-swatch').forEach(sw => {
    sw.addEventListener('click', () => {
      container.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
      sw.classList.add('selected');
      hidden.value = sw.dataset.color;
    });
  });
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1,3), 16);
  const g = parseInt(hex.slice(3,5), 16);
  const b = parseInt(hex.slice(5,7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ===== THEMES =====
const THEMES = {
  clinical: {
    name: 'Clinical',
    preview: ['#F1F5F9','#FFFFFF','#2563EB'],
    vars: {
      '--bg':'#F1F5F9','--card-bg':'#FFFFFF','--surface':'#F8FAFC','--surface-hover':'#F1F5F9',
      '--border':'#E2E8F0','--text-primary':'#1E293B','--text-secondary':'#64748B',
      '--gray-50':'#F8FAFC','--gray-100':'#F1F5F9','--gray-200':'#E2E8F0','--gray-300':'#CBD5E1',
      '--gray-400':'#94A3B8','--gray-500':'#64748B','--gray-600':'#475569','--gray-700':'#334155','--gray-800':'#1E293B',
      '--blue-50':'#EFF6FF','--blue-100':'#DBEAFE','--blue-200':'#BFDBFE','--blue-300':'#93C5FD',
      '--blue-400':'#60A5FA','--blue-500':'#3B82F6','--blue-600':'#2563EB','--blue-700':'#1D4ED8',
      '--green-50':'#F0FDF4','--green-100':'#DCFCE7','--green-500':'#22C55E','--green-600':'#16A34A','--green-700':'#15803D',
      '--red-50':'#FEF2F2','--red-100':'#FEE2E2','--red-200':'#FECACA','--red-500':'#EF4444','--red-600':'#DC2626','--red-700':'#B91C1C',
      '--amber-100':'#FEF3C7','--amber-500':'#F59E0B',
      '--purple-50':'#F5F3FF','--purple-100':'#EDE9FE','--purple-500':'#8B5CF6','--purple-700':'#6D28D9',
    }
  },
  warm: {
    name: 'Warm',
    preview: ['#FDF8F3','#FFFFFF','#D97706'],
    vars: {
      '--bg':'#FDF8F3','--card-bg':'#FFFFFF','--surface':'#FFFAF5','--surface-hover':'#FDF8F3',
      '--border':'#E8DDD0','--text-primary':'#3D2E1F','--text-secondary':'#8B7355',
      '--gray-50':'#FFFAF5','--gray-100':'#FDF8F3','--gray-200':'#E8DDD0','--gray-300':'#D4C5B0',
      '--gray-400':'#A89880','--gray-500':'#8B7355','--gray-600':'#6B5A42','--gray-700':'#4A3D2E','--gray-800':'#3D2E1F',
    }
  },
  midnight: {
    name: 'Midnight',
    preview: ['#0F172A','#1E293B','#3B82F6'],
    vars: {
      '--bg':'#0F172A','--card-bg':'#1E293B','--surface':'#152035','--surface-hover':'#1E293B',
      '--border':'#334155','--text-primary':'#F1F5F9','--text-secondary':'#94A3B8',
      '--gray-50':'#152035','--gray-100':'#1E293B','--gray-200':'#334155','--gray-300':'#475569',
      '--gray-400':'#94A3B8','--gray-500':'#94A3B8','--gray-600':'#CBD5E1','--gray-700':'#E2E8F0','--gray-800':'#F1F5F9',
      '--red-50':'#2A1215','--red-100':'#451A1E','--red-500':'#F87171','--red-600':'#EF4444','--red-700':'#FCA5A5',
      '--green-50':'#0F2A1E','--green-100':'#14532D','--green-500':'#4ADE80','--green-600':'#22C55E','--green-700':'#86EFAC',
      '--blue-50':'#172554','--blue-100':'#1E3A5F','--blue-200':'#60A5FA','--blue-300':'#60A5FA','--blue-400':'#93C5FD','--blue-500':'#3B82F6','--blue-600':'#2563EB','--blue-700':'#1D4ED8',
      '--purple-50':'#2E1065','--purple-100':'#3B0764','--purple-500':'#A78BFA','--purple-700':'#C4B5FD',
      '--amber-100':'#3D2E08','--amber-500':'#FBBF24',
    }
  },
  ocean: {
    name: 'Ocean',
    preview: ['#F0F9FF','#FFFFFF','#0891B2'],
    vars: {
      '--bg':'#F0F9FF','--card-bg':'#FFFFFF','--surface':'#F5FBFF','--surface-hover':'#ECF7FF',
      '--border':'#BAE6FD','--text-primary':'#164E63','--text-secondary':'#4B8CA0',
      '--gray-50':'#F5FBFF','--gray-100':'#F0F9FF','--gray-200':'#BAE6FD','--gray-300':'#7DD3FC',
      '--gray-400':'#4B8CA0','--gray-500':'#4B8CA0','--gray-600':'#0C4A6E','--gray-700':'#164E63','--gray-800':'#164E63',
      '--blue-50':'#F0F9FF','--blue-100':'#E0F2FE','--blue-200':'#BAE6FD','--blue-300':'#7DD3FC','--blue-400':'#38BDF8','--blue-500':'#0891B2','--blue-600':'#0E7490','--blue-700':'#155E75',
    }
  },
  sage: {
    name: 'Sage',
    preview: ['#F2F7F2','#FFFFFF','#16A34A'],
    vars: {
      '--bg':'#F2F7F2','--card-bg':'#FFFFFF','--surface':'#F7FAF7','--surface-hover':'#EDF5ED',
      '--border':'#D1E3D1','--text-primary':'#1A3A1A','--text-secondary':'#5C7A5C',
      '--gray-50':'#F7FAF7','--gray-100':'#F2F7F2','--gray-200':'#D1E3D1','--gray-300':'#B0CCB0',
      '--gray-400':'#7A9C7A','--gray-500':'#5C7A5C','--gray-600':'#3D5C3D','--gray-700':'#2A422A','--gray-800':'#1A3A1A',
      '--blue-50':'#F0FDF4','--blue-100':'#DCFCE7','--blue-200':'#BBF7D0','--blue-300':'#86EFAC','--blue-400':'#4ADE80','--blue-500':'#16A34A','--blue-600':'#15803D','--blue-700':'#166534',
    }
  },
};

function applyTheme(themeId) {
  const theme = THEMES[themeId];
  if (!theme) return;
  const root = document.documentElement;
  // Reset ALL vars to clinical defaults first
  for (const [prop, val] of Object.entries(THEMES.clinical.vars)) {
    root.style.setProperty(prop, val);
  }
  // Then apply the selected theme on top
  for (const [prop, val] of Object.entries(theme.vars)) {
    root.style.setProperty(prop, val);
  }
  localStorage.setItem('theme', themeId);
  document.querySelectorAll('.theme-card').forEach(c => c.classList.toggle('active', c.dataset.theme === themeId));
}

function initThemePicker() {
  const picker = $('theme-picker');
  if (!picker) return;
  const current = localStorage.getItem('theme') || 'clinical';
  picker.innerHTML = Object.entries(THEMES).map(([id, t]) =>
    `<div class="theme-card${id===current?' active':''}" data-theme="${id}">
      <div class="theme-preview">${t.preview.map(c=>`<span style="background:${c}"></span>`).join('')}</div>
      ${t.name}
    </div>`
  ).join('');
  picker.querySelectorAll('.theme-card').forEach(card => {
    card.addEventListener('click', () => applyTheme(card.dataset.theme));
  });
}

// ===== DATA =====
function getBookingsForRoomDate(roomId, date) {
  const ds = dateStr(date), dow = date.getDay(), results = [];
  for (const b of data.bookings) if (b.roomId===roomId && b.date===ds) results.push({...b, isRecurring:false});
  for (const r of data.recurringRules) {
    if (r.roomId===roomId && r.daysOfWeek.includes(dow)) {
      if (!(r.exceptions||[]).includes(ds)) {
        results.push({ id:`${r.id}__${ds}`, ruleId:r.id, roomId:r.roomId, title:r.doctorName,
          details:`Recurring: ${r.daysOfWeek.map(d=>['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d]).join(', ')}`,
          startTime:r.startTime, endTime:r.endTime, date:ds, color:r.color||null, isRecurring:true });
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
    // Always render ALL blocks so nurse can see schedule at a glance
    for(const b of bks){const s=timeToMinutes(b.startTime),e=timeToMinutes(b.endTime),l=(s/1440)*100,w=((e-s)/1440)*100;
      const cur=s<=nm&&e>nm,fut=s>nm,past=e<=nm;
      const mc=b.color||(b.isRecurring?'#16a34a':'#3B82F6');
      const opa=past?0.4:cur?1:0.85;
      mini+=`<div class="mini-block" style="left:${l}%;width:${w}%;background:${mc};opacity:${opa}${cur?';box-shadow:0 0 0 1px '+mc:''}"></div>`;}
    // Add now-line to mini timeline
    mini += `<div class="mini-now-line" style="left:${nowPct}%"></div>`;
    // Check if a booking starts within the next 15 minutes
    const upcoming = !occ && bks.find(b => { const s=timeToMinutes(b.startTime); return s > nm && s <= nm+15; });
    const cardClass = occ ? 'occupied' : upcoming ? 'upcoming' : 'available';
    const statusClass = occ ? 'status-occupied' : upcoming ? 'status-upcoming' : 'status-available';
    const statusText = occ ? 'IN USE' : upcoming ? 'SOON' : 'Open';
    const occupantText = occ ? occ.title : upcoming ? upcoming.title : '';
    return `<div class="room-card ${cardClass}" data-room-id="${room.id}">
      <div class="room-card-header"><span class="room-card-name">${room.name}</span>
        <span class="room-card-status ${statusClass}">${statusText}</span></div>
      <div class="room-card-occupant">${occupantText}</div>
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
  transitionViews('grid-view', 'room-view', () => renderRoom());
}

function renderRoom() {
  const room=data.rooms.find(r=>r.id===currentRoomId); if(!room) return;
  $('room-title').textContent=room.name;
  document.querySelectorAll('.view-toggle-btn').forEach(b=>b.classList.toggle('active',b.dataset.view===roomViewMode));

  // Day view uses split layout; week/month use full-screen calendar-container
  if(roomViewMode==='day'){
    show('day-split-layout'); hide('calendar-container');
    // Hide the +Add Booking button in header (it's inline now)
    $('add-booking-btn').style.display='none';
    renderDayView();
  } else {
    hide('day-split-layout'); show('calendar-container');
    $('add-booking-btn').style.display='';
    if(roomViewMode==='week') renderWeekView();
    else renderMonthView();
  }
}

// ===== DRAG-TO-MOVE EVENT BLOCKS =====
function setupEventDrag(container, eventSelector, scrollParent) {
  container.querySelectorAll(eventSelector).forEach(el => {
    let startY = 0, origTop = 0, dragging = false, moved = false;
    el.style.cursor = 'grab';

    el.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      const booking = JSON.parse(el.dataset.booking);
      // Don't allow dragging recurring instances (they're rule-based)
      if (booking.isRecurring) return;
      e.preventDefault(); e.stopPropagation();
      dragging = true; moved = false;
      startY = e.clientY;
      origTop = parseInt(el.style.top, 10);
      el.style.cursor = 'grabbing';
      el.style.opacity = '0.8';
      el.style.zIndex = '20';

      function onMove(e2) {
        const dy = e2.clientY - startY;
        if (Math.abs(dy) > 3) moved = true;
        const newTop = Math.max(0, Math.round((origTop + dy) / 15) * 15);
        el.style.top = newTop + 'px';
      }

      async function onUp() {
        dragging = false;
        el.style.cursor = 'grab';
        el.style.opacity = '';
        el.style.zIndex = '';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);

        if (!moved) return; // was a click, not a drag

        const newTop = parseInt(el.style.top, 10);
        const delta = newTop - origTop; // minutes shifted
        if (delta === 0) return;

        const booking = JSON.parse(el.dataset.booking);
        const oldStart = timeToMinutes(booking.startTime);
        const oldEnd = timeToMinutes(booking.endTime);
        const duration = oldEnd - oldStart;
        const newStart = Math.max(0, Math.min(1440 - duration, newTop));
        const newEnd = newStart + duration;

        // Find and update the actual booking in data
        const b = data.bookings.find(x => x.id === booking.id);
        if (b) {
          b.startTime = minutesToTime(newStart);
          b.endTime = minutesToTime(newEnd);
          renderRoom();
          toast(`Moved to ${formatTimeDisplay(b.startTime)}`);
          try { await store.save(data); } catch (err) { toast('Error saving'); console.error(err); }
        }
      }

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    // Prevent click (delete modal) if we dragged
    el.addEventListener('click', e => {
      if (moved) { e.stopPropagation(); moved = false; }
    }, true);
  });
}

// ===== DRAG-TO-CREATE NEW BLOCKS =====
function setupDragCreate(evCol, scrollParent) {
  let dragging = false, preview = null, startMin = 0, endMin = 0;

  evCol.addEventListener('mousedown', e => {
    if (e.button !== 0 || e.target.closest('.event-block') || e.target.closest('.quick-add-block')) return;
    e.preventDefault();
    dragging = true;
    const y = e.clientY - evCol.getBoundingClientRect().top;
    startMin = Math.round(y / 15) * 15;
    endMin = startMin + 15;

    // Create preview element
    preview = document.createElement('div');
    preview.className = 'drag-create-preview';
    preview.style.top = startMin + 'px';
    preview.style.height = '15px';
    preview.textContent = formatTimeDisplay(minutesToTime(startMin));
    evCol.appendChild(preview);

    function onMove(e2) {
      const y2 = e2.clientY - evCol.getBoundingClientRect().top;
      endMin = Math.round(y2 / 15) * 15;
      // Allow dragging up or down
      const top = Math.min(startMin, endMin);
      const bot = Math.max(startMin, endMin);
      const h = Math.max(bot - top, 15);
      preview.style.top = top + 'px';
      preview.style.height = h + 'px';
      preview.textContent = `${formatTimeDisplay(minutesToTime(top))} – ${formatTimeDisplay(minutesToTime(top + h))}`;
    }

    function onUp() {
      dragging = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);

      if (preview) preview.remove();

      const top = Math.min(startMin, endMin);
      const bot = Math.max(startMin, endMin);
      const finalStart = Math.max(0, top);
      const finalEnd = Math.max(finalStart + 15, bot);

      // Show quick-add input right on the block
      showQuickAdd(evCol, scrollParent, finalStart, finalEnd);
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function showQuickAdd(evCol, scrollParent, startMins, endMins) {
  // Remove any existing quick-add
  evCol.querySelectorAll('.quick-add-block').forEach(el => el.remove());

  const block = document.createElement('div');
  block.className = 'quick-add-block';
  block.style.top = startMins + 'px';
  block.style.height = Math.max(endMins - startMins, 30) + 'px';

  const timeLabel = document.createElement('div');
  timeLabel.className = 'quick-add-time';
  timeLabel.textContent = `${formatTimeDisplay(minutesToTime(startMins))} – ${formatTimeDisplay(minutesToTime(endMins))}`;

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Title, then Enter';
  input.autocomplete = 'off';

  block.appendChild(timeLabel);
  block.appendChild(input);

  const cancelBtn = document.createElement('button');
  cancelBtn.innerHTML = '&times;';
  cancelBtn.style.cssText = 'position:absolute;top:2px;right:4px;border:none;background:transparent;font-size:18px;cursor:pointer;color:var(--gray-400);padding:2px 6px;border-radius:4px;';
  cancelBtn.addEventListener('click', (e) => { e.stopPropagation(); block.remove(); });
  block.appendChild(cancelBtn);

  evCol.appendChild(block);
  input.focus();

  // Also update the side panel times
  bookingDate = dateStr(selectedDate);
  if (inlineStartInput) inlineStartInput.setMins(startMins);
  if (inlineEndInput) inlineEndInput.setMins(endMins);

  async function save() {
    const title = input.value.trim();
    if (!title) { block.remove(); return; }

    if (!data.knownNames) data.knownNames = [];
    if (!data.knownNames.includes(title)) data.knownNames.push(title);

    const color = $('inline-booking-color')?.value || '#3B82F6';
    data.bookings.push({
      id: genId(), roomId: currentRoomId, title, details: '',
      date: bookingDate || dateStr(selectedDate),
      startTime: minutesToTime(startMins), endTime: minutesToTime(endMins),
      color, createdAt: new Date().toISOString()
    });

    block.remove();
    renderRoom();
    toast('Booking saved');
    try { await store.save(data); } catch (err) { toast('Error saving'); console.error(err); }
  }

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); save(); }
    if (e.key === 'Escape') { block.remove(); }
  });

  input.addEventListener('blur', () => {
    // Small delay so click events can fire first
    setTimeout(() => { if (block.parentNode) block.remove(); }, 200);
  });
}

// ===== DAY VIEW (split layout: calendar left, booking form right) =====
function renderDayView() {
  const container=$('day-split-calendar'), today=new Date();
  $('room-date-display').textContent=formatDateFull(selectedDate);

  let timeHTML='';
  for(let h=0;h<24;h++){const ap=h>=12?'PM':'AM',h12=h===0?12:h>12?h-12:h; timeHTML+=`<div class="time-label">${h12} ${ap}</div>`;}

  let hourLines='';
  for(let h=0;h<24;h++) hourLines+=`<div class="hour-line" style="top:${h*60}px"></div>`;

  // Now line (no dot)
  let nowLineHTML='';
  if(sameDay(selectedDate,today)){const nm=today.getHours()*60+today.getMinutes(); nowLineHTML=`<div class="now-line" style="top:${nm}px"></div>`;}

  const bookings=getBookingsForRoomDate(currentRoomId,selectedDate);
  let evHTML='';
  for(const b of bookings){
    const sm=timeToMinutes(b.startTime),em=timeToMinutes(b.endTime),h=Math.max(em-sm,15);
    const color = b.color || (b.isRecurring ? '#16a34a' : '#3B82F6');
    const colorStyle = `background:${hexToRgba(color,0.2)};border-left-color:${color};`;
    evHTML+=`<div class="event-block${b.isRecurring?' recurring':''}" style="top:${sm}px;height:${h}px;${colorStyle}" data-booking='${JSON.stringify(b).replace(/'/g,"&#39;")}'>
      <div class="event-title">${b.title}</div>
      <div class="event-time">${formatTimeDisplay(b.startTime)} – ${formatTimeDisplay(b.endTime)}</div>
      ${b.details?`<div class="event-details">${b.isRecurring?'Recurring office':b.details}</div>`:''}
    </div>`;
  }

  container.innerHTML=`<div class="day-view"><div class="time-column">${timeHTML}</div><div class="events-column" id="day-events-col">${hourLines}${nowLineHTML}${evHTML}</div></div>`;

  // Scroll to center now-line on screen
  if(sameDay(selectedDate,today)){
    const nm=today.getHours()*60+today.getMinutes();
    container.scrollTop=Math.max(0,nm-container.clientHeight/2);
  } else container.scrollTop=7*60;

  // Click event blocks to edit (only if not dragged)
  container.querySelectorAll('.event-block').forEach(el=>{
    el.addEventListener('click',e=>{
      e.stopPropagation();
      const booking=JSON.parse(el.dataset.booking);
      editBookingInPanel(booking);
    });
  });

  // Drag event blocks to reschedule
  setupEventDrag(container, '.event-block', container);

  // Drag on empty space to create a new block
  const evCol=container.querySelector('.events-column');
  if(evCol) setupDragCreate(evCol, container);

  // Reset inline panel for this date
  bookingDate=dateStr(selectedDate);
  resetInlinePanel();
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
    let nl=''; if(sameDay(d,today)){const nm=today.getHours()*60+today.getMinutes(); nl=`<div class="now-line" style="top:${nm}px"></div>`;}
    let ev=''; for(const b of bks){const sm=timeToMinutes(b.startTime),em=timeToMinutes(b.endTime),h=Math.max(em-sm,15);
      const wc=b.color||(b.isRecurring?'#16a34a':'#3B82F6');const wcs=`background:${hexToRgba(wc,0.2)};border-left-color:${wc};`;
      ev+=`<div class="week-event${b.isRecurring?' recurring':''}" style="top:${sm}px;height:${h}px;${wcs}" data-booking='${JSON.stringify(b).replace(/'/g,"&#39;")}'><div class="week-event-title">${b.title}</div>${h>=30?`<div class="week-event-time">${formatTimeDisplay(b.startTime)}</div>`:''}</div>`;}
    cols+=`<div class="week-day-col" data-date="${ds}">${lines}${nl}${ev}</div>`;
  }

  container.innerHTML=`<div class="week-view"><div class="week-header">${hdr}</div><div class="week-body" id="week-body"><div class="week-time-col">${timeHTML}</div>${cols}</div></div>`;
  const body=$('week-body'); if(body){if(sameDay(selectedDate,today)){const nm=today.getHours()*60+today.getMinutes();body.scrollTop=Math.max(0,nm-body.clientHeight/2);}else body.scrollTop=7*60;}
  container.querySelectorAll('.week-event').forEach(el=>{el.addEventListener('click',e=>{e.stopPropagation();showDeleteModal(JSON.parse(el.dataset.booking));});});
  container.querySelectorAll('.week-day-col').forEach(col=>{col.addEventListener('dblclick',e=>{if(e.target.closest('.week-event'))return;const y=e.clientY-col.getBoundingClientRect().top+col.parentElement.scrollTop;bookingDate=col.dataset.date;openBookingModal(Math.round(y/15)*15);});});

  // Drag event blocks to reschedule in week view
  setupEventDrag(container, '.week-event', $('week-body'));
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
function initTimeInput(containerId, hiddenId, onChange) {
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
    if (onChange) onChange();
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
let inlineStartInput, inlineEndInput;

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

function setupInlineAutocomplete() {
  const input = $('inline-booking-title'), dropdown = $('inline-autocomplete-dropdown');
  let items = [], idx = -1;
  function render(matches) {
    if (!matches.length) { dropdown.style.display = 'none'; idx = -1; return; }
    items = matches;
    dropdown.innerHTML = matches.map((m, i) => `<div class="autocomplete-item${i===idx?' active':''}" data-idx="${i}">${m}</div>`).join('') + '<div class="autocomplete-hint">Tab to select</div>';
    dropdown.style.display = '';
  }
  input.addEventListener('input', () => {
    const val = input.value.trim().toLowerCase();
    if (!val) { dropdown.style.display = 'none'; return; }
    const matches = getKnownNames().filter(n => n.toLowerCase().includes(val));
    idx = matches.length > 0 ? 0 : -1; render(matches);
  });
  input.addEventListener('keydown', e => {
    if (dropdown.style.display === 'none' || !items.length) return;
    if (e.key === 'Tab' || e.key === 'Enter') { if (idx >= 0) { e.preventDefault(); input.value = items[idx]; dropdown.style.display = 'none'; } }
    else if (e.key === 'ArrowDown') { e.preventDefault(); idx = Math.min(idx + 1, items.length - 1); render(items); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); idx = Math.max(idx - 1, 0); render(items); }
    else if (e.key === 'Escape') { dropdown.style.display = 'none'; }
  });
  dropdown.addEventListener('click', e => { const item = e.target.closest('.autocomplete-item'); if (item) { input.value = items[Number(item.dataset.idx)]; dropdown.style.display = 'none'; input.focus(); } });
  input.addEventListener('blur', () => { setTimeout(() => { dropdown.style.display = 'none'; }, 200); });
}

// ===== OVERLAP CHECK =====
function checkOverlap(roomId, date, startTime, endTime, excludeId) {
  const bks = getBookingsForRoomDate(roomId, typeof date === 'string' ? parseDateStr(date) : date);
  const sm = timeToMinutes(startTime), em = timeToMinutes(endTime);
  const conflicts = [];
  for (const b of bks) {
    if (excludeId && (b.id === excludeId)) continue;
    const bs = timeToMinutes(b.startTime), be = timeToMinutes(b.endTime);
    if (sm < be && em > bs) conflicts.push(b);
  }
  return conflicts;
}

function overlapWarningHTML(conflicts) {
  if (!conflicts.length) return '';
  const names = conflicts.map(c => `"${c.title}" (${formatTimeDisplay(c.startTime)}–${formatTimeDisplay(c.endTime)})`).join(', ');
  return `<div class="overlap-warning">⚠ Overlaps with ${names}</div>`;
}

function updateOverlapWarning(containerId, roomId, date, startTime, endTime, excludeId) {
  const el = $(containerId);
  if (!el) return;
  const conflicts = checkOverlap(roomId, date, startTime, endTime, excludeId);
  el.innerHTML = overlapWarningHTML(conflicts);
}

function checkInlineOverlap() {
  const st=$('inline-booking-start')?.value, et=$('inline-booking-end')?.value;
  if(!st||!et||!currentRoomId) return;
  const d=bookingDate||dateStr(selectedDate);
  updateOverlapWarning('inline-overlap-warning',currentRoomId,d,st,et,editingBookingId);
}
function checkModalOverlap() {
  const st=$('booking-start')?.value, et=$('booking-end')?.value;
  if(!st||!et||!currentRoomId) return;
  const d=bookingDate||dateStr(selectedDate);
  updateOverlapWarning('modal-overlap-warning',currentRoomId,d,st,et,null);
}

// ===== BOOKING MODAL =====
// ===== INLINE BOOKING PANEL (day view) =====
function editBookingInPanel(booking) {
  bookingDate = booking.date;
  $('inline-booking-title').value = booking.title || '';
  $('inline-booking-details').value = booking.details || '';
  if(inlineStartInput) inlineStartInput.setMins(timeToMinutes(booking.startTime));
  if(inlineEndInput) inlineEndInput.setMins(timeToMinutes(booking.endTime));

  // Set color
  const color = booking.color || '#3B82F6';
  $('inline-booking-color').value = color;
  $('inline-color-picker')?.querySelectorAll('.color-swatch').forEach(s =>
    s.classList.toggle('selected', s.dataset.color === color));

  if(booking.isRecurring) {
    // For recurring, show the recurring options
    $('inline-booking-recurring').checked = true;
    $('inline-recurring-btn').classList.add('active');
    show('inline-recurring-options');
    $('inline-recurring-doctor').value = booking.title || '';
    // We can't fully edit recurring rules inline easily, so just show delete option
    editingBookingId = null;
    showDeleteModal(booking);
    return;
  }

  editingBookingId = booking.id;
  $('inline-booking-recurring').checked = false;
  $('inline-recurring-btn').classList.remove('active');
  hide('inline-recurring-options');

  // Change header and button to "Edit/Update"
  $('inline-panel-title').textContent = 'Edit Booking';
  $('inline-save-btn').textContent = 'Update Booking';
  $('inline-delete-btn').style.display = '';
  $('inline-delete-btn').onclick = () => showDeleteModal(booking);
  $('inline-booking-title').focus();
  checkInlineOverlap();
}

function resetInlinePanel() {
  $('inline-booking-title').value='';
  $('inline-booking-details').value='';
  const now=new Date();
  const mins=Math.ceil((now.getHours()*60+now.getMinutes())/15)*15;
  if(inlineStartInput) inlineStartInput.setMins(mins);
  if(inlineEndInput) inlineEndInput.setMins(mins+60);
  $('inline-booking-recurring').checked=false;
  $('inline-recurring-btn').classList.remove('active');
  hide('inline-recurring-options');
  $('inline-day-picker')?.querySelectorAll('.day-btn').forEach(b=>b.classList.remove('selected'));
  // Reset color to default blue
  $('inline-booking-color').value='#3B82F6';
  $('inline-color-picker')?.querySelectorAll('.color-swatch').forEach(s=>s.classList.toggle('selected',s.dataset.color==='#3B82F6'));
  editingBookingId = null;
  $('inline-panel-title').textContent = 'New Booking';
  $('inline-save-btn').textContent = 'Save Booking';
  $('inline-delete-btn').style.display = 'none';
  $('inline-delete-btn').onclick = null;
  const ow=$('inline-overlap-warning'); if(ow) ow.innerHTML='';
}

async function saveInlineBooking() {
  const title=$('inline-booking-title').value.trim(), details=$('inline-booking-details').value.trim();
  const startTime=$('inline-booking-start').value, endTime=$('inline-booking-end').value;
  const isRecurring=$('inline-booking-recurring').checked;
  if(!title){toast('Please enter a title');return;}
  if(timeToMinutes(endTime)<=timeToMinutes(startTime)){toast('End time must be after start time');return;}

  if(!data.knownNames) data.knownNames=[];
  if(!data.knownNames.includes(title)) data.knownNames.push(title);

  if(isRecurring){
    const doc=$('inline-recurring-doctor').value.trim();
    const days=[...$('inline-day-picker').querySelectorAll('.day-btn.selected')].map(b=>Number(b.dataset.day));
    if(!doc){toast('Enter doctor name');return;} if(!days.length){toast('Select days');return;}
    if(!data.knownNames.includes(doc)) data.knownNames.push(doc);
    const recurColor=$('inline-booking-color').value;
    data.recurringRules.push({id:genId(),roomId:currentRoomId,doctorName:doc,daysOfWeek:days,startTime,endTime,color:recurColor,exceptions:[],createdAt:new Date().toISOString()});
  } else {
    const color=$('inline-booking-color').value;
    if (editingBookingId) {
      // Update existing booking
      const existing = data.bookings.find(b => b.id === editingBookingId);
      if (existing) {
        existing.title = title;
        existing.details = details;
        existing.startTime = startTime;
        existing.endTime = endTime;
        existing.color = color;
      }
    } else {
      data.bookings.push({id:genId(),roomId:currentRoomId,title,details,date:bookingDate||dateStr(selectedDate),startTime,endTime,color,createdAt:new Date().toISOString()});
    }
  }
  resetInlinePanel(); renderRoom(); toast('Booking saved');
  try{await store.save(data);}catch(e){toast('Error saving');console.error(e);}
}

function openBookingModal(startMinutes) {
  $('modal-title').textContent='New Booking';
  $('booking-title').value=''; $('booking-details').value='';
  startInput.setMins(startMinutes||480); endInput.setMins((startMinutes||480)+60);
  $('booking-recurring').checked=false; hide('recurring-options');
  $('booking-recurring-btn').classList.remove('active');
  $('recurring-doctor').value='';
  document.querySelectorAll('.day-btn').forEach(b=>b.classList.remove('selected'));
  $('autocomplete-dropdown').style.display='none';
  // Reset color to default blue
  $('booking-color').value='#3B82F6';
  $('modal-color-picker')?.querySelectorAll('.color-swatch').forEach(s=>s.classList.toggle('selected',s.dataset.color==='#3B82F6'));
  show('booking-modal'); $('booking-title').focus();
  checkModalOverlap();
}
function closeBookingModal() { hide('booking-modal'); bookingDate=null; const ow=$('modal-overlap-warning'); if(ow) ow.innerHTML=''; }

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
    const doc=$('recurring-doctor').value.trim(), days=[...$('day-picker').querySelectorAll('.day-btn.selected')].map(b=>Number(b.dataset.day));
    if(!doc){toast('Enter doctor name');return;} if(!days.length){toast('Select days');return;}
    if(!data.knownNames.includes(doc)) data.knownNames.push(doc);
    const recurColor=$('booking-color').value;
    data.recurringRules.push({id:genId(),roomId:currentRoomId,doctorName:doc,daysOfWeek:days,startTime,endTime,color:recurColor,exceptions:[],createdAt:new Date().toISOString()});
  } else {
    const color=$('booking-color').value;
    data.bookings.push({id:genId(),roomId:currentRoomId,title,details,date:bookingDate||dateStr(selectedDate),startTime,endTime,color,createdAt:new Date().toISOString()});
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
  initThemePicker();
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
    if(demoMode)return;
    try{
      data=await store.load();
      pruneOldData(data);
      if($('grid-view').style.display!=='none')renderGrid();
      // Don't re-render room view if user is filling in the booking form
      if($('room-view').style.display!=='none'){
        const activeEl=document.activeElement;
        const isEditing = activeEl && (
          activeEl.closest('#day-split-panel') ||
          activeEl.closest('#booking-modal') ||
          activeEl.closest('.quick-add-block')
        );
        if(!isEditing) renderRoom();
      }
    }catch(e){console.warn('Auto-sync failed:',e);}
  },30000);
}

// ===== DEMO WALKTHROUGH =====
function generateDemoData() {
  const demoData = JSON.parse(JSON.stringify(data));
  const today = new Date();
  const bookings = [];
  const rules = [];

  // Generate bookings for today, yesterday, and tomorrow
  for (let dayOffset = -1; dayOffset <= 1; dayOffset++) {
    const date = addDays(today, dayOffset);
    const dateString = dateStr(date);
    const bookingsPerRoomCount = dayOffset === 0 ? Math.floor(Math.random() * 4) + 2 : Math.floor(Math.random() * 2) + 1;

    // Pick a subset of rooms for this date
    const roomsToFill = demoData.rooms.slice(0, Math.max(3, Math.floor(demoData.rooms.length / 2)));

    for (const room of roomsToFill) {
      const numBookings = Math.max(1, bookingsPerRoomCount - Math.floor(Math.random() * 2));
      for (let i = 0; i < numBookings; i++) {
        const doctor = DEMO_DOCTORS[Math.floor(Math.random() * DEMO_DOCTORS.length)];
        const detail = DEMO_DETAILS[Math.floor(Math.random() * DEMO_DETAILS.length)];
        const color = COLORS[Math.floor(Math.random() * COLORS.length)];

        // Duration: 15, 30, 45, 60, 90, or 120 minutes
        const durations = [15, 30, 45, 60, 90, 120];
        const duration = durations[Math.floor(Math.random() * durations.length)];

        // Start time between 7am-7pm (420-1140 minutes)
        const startMin = Math.floor(Math.random() * (1140 - 420)) + 420;
        // Ensure no overlap by checking existing bookings for this room/date
        let finalStart = startMin;
        while (bookings.some(b =>
          b.roomId === room.id && b.date === dateString &&
          timeToMinutes(b.startTime) < finalStart + duration && timeToMinutes(b.endTime) > finalStart
        )) {
          finalStart = Math.min(1320, finalStart + 30); // shift 30 min later, cap at 10pm
        }

        const endMin = finalStart + duration;
        if (endMin <= 1440) {
          bookings.push({
            id: genId(),
            roomId: room.id,
            title: doctor,
            details: detail,
            date: dateString,
            startTime: minutesToTime(finalStart),
            endTime: minutesToTime(endMin),
            color: color,
            createdAt: new Date().toISOString()
          });
        }
      }
    }
  }

  demoData.bookings = bookings;

  // Create 3-5 recurring rules with different doctors on different days
  const numRules = Math.floor(Math.random() * 3) + 3;
  for (let i = 0; i < numRules; i++) {
    const room = demoData.rooms[Math.floor(Math.random() * demoData.rooms.length)];
    const doctor = DEMO_DOCTORS[Math.floor(Math.random() * DEMO_DOCTORS.length)];
    const color = COLORS[Math.floor(Math.random() * COLORS.length)];
    const daysOfWeek = [];
    for (let d = 0; d < 7; d++) {
      if (Math.random() > 0.5) daysOfWeek.push(d);
    }
    if (daysOfWeek.length === 0) daysOfWeek.push(Math.floor(Math.random() * 7));

    const startMin = Math.floor(Math.random() * (1020 - 420)) + 420; // 7am-5pm
    rules.push({
      id: genId(),
      roomId: room.id,
      doctorName: doctor,
      daysOfWeek: daysOfWeek,
      startTime: minutesToTime(startMin),
      endTime: minutesToTime(startMin + 60),
      color: color,
      exceptions: [],
      createdAt: new Date().toISOString()
    });
  }

  demoData.recurringRules = rules;
  return demoData;
}

function startDemo() {
  // Save original data
  originalData = JSON.parse(JSON.stringify(data));
  demoMode = true;

  // Generate and load demo data
  data = generateDemoData();

  // Close settings modal
  closeSettings();

  // Re-render
  renderGrid();

  // Show exit demo button
  show('exit-demo-btn');

  // Start the tour
  startTour();
}

function exitDemo() {
  // Restore original data
  data = originalData;
  demoMode = false;
  originalData = null;

  // Hide tour and exit button
  hide('tour-overlay');
  hide('exit-demo-btn');

  // Re-render
  if (currentRoomId) {
    renderRoom();
  } else {
    renderGrid();
  }

  toast('Demo mode ended — your data is restored');
}

function startTour() {
  tourStep = 0;

  // Define tour steps
  tourSteps = [
    {
      target: null,
      text: '<h4>Welcome to Carla Scheduler!</h4>Let\'s walk through how everything works. You\'ll learn to schedule bookings, manage rooms, and stay organized.',
      arrow: 'bottom'
    },
    {
      target: 'room-grid',
      text: '<h4>Room Overview</h4>This is your room grid. Each card shows a room\'s status — green is open, red is in use, dark green means someone\'s coming soon.',
      arrow: 'top'
    },
    {
      target: document.querySelector('.room-card'),
      text: '<h4>Room Cards</h4>Each card displays a mini timeline of today\'s bookings. You can see at a glance who\'s in each room and when.',
      arrow: 'top'
    },
    {
      target: document.querySelector('.room-card'),
      text: '<h4>Let\'s Explore a Room</h4>Click any room to see its full schedule and manage bookings in detail. Let\'s look at this one.',
      arrow: 'top',
      action: () => {
        const firstRoom = data.rooms.find(r => r.floorId === currentFloorId);
        if (firstRoom) openRoom(firstRoom.id);
      }
    },
    {
      target: 'day-split-calendar',
      text: '<h4>Day View</h4>This is the day view. Bookings appear as colored blocks. The red line shows the current time.',
      arrow: 'right'
    },
    {
      target: 'day-split-panel',
      text: '<h4>Booking Panel</h4>Use this panel on the right to create new bookings. Set a title, time, and pick any color.',
      arrow: 'left'
    },
    {
      target: 'day-events-col',
      text: '<h4>Drag-to-Create</h4>You can click and drag on the calendar to quickly create a booking. Perfect for fast scheduling.',
      arrow: 'right'
    },
    {
      target: 'view-toggle',
      text: '<h4>View Modes</h4>Switch between day, week, and month views here to see your schedule from different perspectives.',
      arrow: 'bottom'
    },
    {
      target: 'settings-btn',
      text: '<h4>Settings</h4>Open settings to manage floors, rooms, and themes. Customize your workspace here.',
      arrow: 'bottom'
    },
    {
      target: null,
      text: '<h4>Ready to Go!</h4>That\'s it! You\'re ready to start scheduling. Exit demo mode anytime from settings.',
      arrow: 'top'
    }
  ];

  showTourStep(0);
  show('tour-overlay');
}

function showTourStep(index) {
  if (index < 0 || index >= tourSteps.length) {
    endTour();
    return;
  }

  tourStep = index;
  const step = tourSteps[index];

  // Get target element
  let targetEl = null;
  if (step.target) {
    if (typeof step.target === 'string') {
      targetEl = $(step.target);
    } else if (step.target instanceof HTMLElement) {
      targetEl = step.target;
    }
  }

  // Execute action if present
  if (step.action) {
    step.action();
    // Wait for DOM/transitions to settle, then find target again
    setTimeout(() => {
      if (step.target && typeof step.target === 'string') {
        targetEl = $(step.target);
      }
      positionTooltip(targetEl, step);
    }, 550);
  } else {
    positionTooltip(targetEl, step);
  }

  // Update button text
  const isLastStep = index === tourSteps.length - 1;
  $('tour-next-btn').textContent = isLastStep ? 'Finish' : 'Next';

  // Update step counter
  $('tour-step-count').textContent = `${index + 1} of ${tourSteps.length}`;
}

function positionTooltip(targetEl, step) {
  const overlay = $('tour-overlay');
  const spotlight = $('tour-spotlight');
  const tooltip = $('tour-tooltip');
  const textEl = $('tour-text');

  // Update text
  textEl.innerHTML = step.text;

  // Remove previous arrow class
  tooltip.className = 'tour-tooltip arrow-' + (step.arrow || 'top');

  if (targetEl) {
    const rect = targetEl.getBoundingClientRect();
    const padding = 8;

    // Position spotlight
    spotlight.style.top = (rect.top - padding) + 'px';
    spotlight.style.left = (rect.left - padding) + 'px';
    spotlight.style.width = (rect.width + padding * 2) + 'px';
    spotlight.style.height = (rect.height + padding * 2) + 'px';

    // Position tooltip near spotlight
    const tooltipWidth = 360;
    const tooltipHeight = 150; // estimate
    const gap = 16;

    let top, left, arrowDir;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    // Try to place below first
    if (rect.bottom + gap + tooltipHeight < viewportHeight) {
      top = rect.bottom + gap;
      arrowDir = 'top';
    } else if (rect.top - gap - tooltipHeight > 0) {
      top = rect.top - gap - tooltipHeight;
      arrowDir = 'bottom';
    } else {
      top = Math.max(16, Math.min(viewportHeight - tooltipHeight - 16, rect.top - tooltipHeight / 2));
      arrowDir = rect.left > viewportWidth / 2 ? 'right' : 'left';
    }

    // Try to center horizontally
    if (arrowDir === 'top' || arrowDir === 'bottom') {
      left = Math.max(16, Math.min(viewportWidth - tooltipWidth - 16, rect.left + rect.width / 2 - tooltipWidth / 2));
    } else {
      // Side placement
      if (rect.right + gap + tooltipWidth < viewportWidth) {
        left = rect.right + gap;
        arrowDir = 'left';
      } else {
        left = rect.left - gap - tooltipWidth;
        arrowDir = 'right';
      }
    }

    tooltip.className = 'tour-tooltip arrow-' + arrowDir;
    tooltip.style.top = top + 'px';
    tooltip.style.left = left + 'px';
  } else {
    // Center tooltip on screen
    const tooltipWidth = 360;
    tooltip.style.top = (window.innerHeight / 2 - 100) + 'px';
    tooltip.style.left = (window.innerWidth / 2 - tooltipWidth / 2) + 'px';
    tooltip.className = 'tour-tooltip arrow-bottom';
    spotlight.style.width = '0';
    spotlight.style.height = '0';
  }
}

function nextTourStep() {
  if (tourStep === tourSteps.length - 1) {
    endTour();
  } else {
    showTourStep(tourStep + 1);
  }
}

function endTour() {
  hide('tour-overlay');
  toast('Demo complete! Exit demo mode from settings anytime.');
}

// ===== INIT =====
async function init() {
  // Restore saved theme
  const savedTheme = localStorage.getItem('theme');
  if (savedTheme && THEMES[savedTheme]) applyTheme(savedTheme);

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
  // Init time inputs (modal)
  startInput=initTimeInput('start-time-input','booking-start',checkModalOverlap);
  endInput=initTimeInput('end-time-input','booking-end',checkModalOverlap);
  // Init inline time inputs (day split panel)
  inlineStartInput=initTimeInput('inline-start-time-input','inline-booking-start',checkInlineOverlap);
  inlineEndInput=initTimeInput('inline-end-time-input','inline-booking-end',checkInlineOverlap);
  // Init color pickers
  initColorPicker('modal-color-picker','booking-color');
  initColorPicker('inline-color-picker','inline-booking-color');
  setupAutocomplete();
  setupInlineAutocomplete();

  // Inline panel events
  $('inline-save-btn').addEventListener('click',saveInlineBooking);
  $('inline-recurring-btn').addEventListener('click',()=>{
    const cb=$('inline-booking-recurring'), btn=$('inline-recurring-btn');
    cb.checked=!cb.checked; btn.classList.toggle('active',cb.checked);
    if(cb.checked){show('inline-recurring-options');$('inline-booking-title').placeholder='Auto-filled from doctor name';}
    else{hide('inline-recurring-options');$('inline-booking-title').placeholder='e.g., Dr. Smith';}
  });
  $('inline-recurring-doctor')?.addEventListener('input',()=>{if($('inline-booking-recurring').checked)$('inline-booking-title').value=$('inline-recurring-doctor').value;});
  $('inline-day-picker')?.querySelectorAll('.day-btn').forEach(b=>{b.addEventListener('click',e=>{e.preventDefault();b.classList.toggle('selected');});});

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
  $('back-btn').addEventListener('click',()=>{
    currentRoomId=null;hide('day-split-layout');
    transitionViews('room-view','grid-view',()=>{renderFloorTabs();renderGrid();startNowTimer();startAutoSync();});
  });

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
  $('day-picker').querySelectorAll('.day-btn').forEach(b=>{b.addEventListener('click',e=>{e.preventDefault();b.classList.toggle('selected');});});

  // Enter key saves booking unless details textarea is focused
  document.addEventListener('keydown',e=>{
    if(e.key!=='Enter') return;
    const active=document.activeElement;
    // Don't trigger if inside a time-part input
    if(active && active.closest && active.closest('.time-part')) return;

    // Modal booking form
    if($('booking-modal').style.display!=='none'){
      if(active && active.id==='booking-details') return;
      if($('autocomplete-dropdown').style.display!=='none') return;
      e.preventDefault(); saveBooking(); return;
    }
    // Inline day-view booking panel
    if($('day-split-layout').style.display!=='none'){
      if(active && active.id==='inline-booking-details') return;
      if($('inline-autocomplete-dropdown').style.display!=='none') return;
      // Only trigger if focus is inside the panel
      if(active && active.closest && active.closest('#day-split-panel')){
        e.preventDefault(); saveInlineBooking(); return;
      }
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

  // Demo walkthrough
  $('demo-walkthrough-btn').addEventListener('click',startDemo);
  $('exit-demo-btn').addEventListener('click',exitDemo);
  $('tour-next-btn').addEventListener('click',nextTourStep);

  // Close modals on overlay
  document.querySelectorAll('.modal-overlay').forEach(o=>{o.addEventListener('click',e=>{if(e.target===o)o.style.display='none';});});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){if($('booking-modal').style.display!=='none')closeBookingModal();if($('delete-modal').style.display!=='none')closeDeleteModal();if($('settings-modal').style.display!=='none'){closeSettings();renderGrid();}}});

  init();
});
