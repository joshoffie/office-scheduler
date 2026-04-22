// ===== CONFIGURATION =====
const REPO_OWNER = 'Joshoffie';
const REPO_NAME = 'office-scheduler';
const DATA_FILE = 'data.json';
const BRANCH = 'main';

// ===== GITHUB STORAGE LAYER =====
class GitHubStore {
  constructor(token) {
    this.token = token;
    this.baseUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${DATA_FILE}`;
    this.sha = null;
    this.cache = null;
    this.saving = false;
    this.pendingSave = null;
  }

  headers() {
    return {
      'Authorization': `token ${this.token}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    };
  }

  async load() {
    try {
      const res = await fetch(this.baseUrl + `?ref=${BRANCH}&t=${Date.now()}`, { headers: this.headers() });
      if (res.status === 404) {
        // File doesn't exist yet, create with defaults
        const defaults = this.defaultData();
        await this.saveRaw(defaults);
        return defaults;
      }
      if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
      const json = await res.json();
      this.sha = json.sha;
      const content = JSON.parse(atob(json.content.replace(/\n/g, '')));
      this.cache = content;
      return content;
    } catch (err) {
      console.error('Load error:', err);
      throw err;
    }
  }

  async save(data) {
    // Debounce: if already saving, queue the latest
    if (this.saving) {
      this.pendingSave = data;
      return;
    }
    this.saving = true;
    try {
      await this.saveRaw(data);
    } finally {
      this.saving = false;
      if (this.pendingSave) {
        const next = this.pendingSave;
        this.pendingSave = null;
        await this.save(next);
      }
    }
  }

  async saveRaw(data) {
    this.cache = data;
    const body = {
      message: `Update scheduler data ${new Date().toISOString()}`,
      content: btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2)))),
      branch: BRANCH,
    };
    if (this.sha) body.sha = this.sha;

    const res = await fetch(this.baseUrl, {
      method: 'PUT',
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    if (res.status === 409) {
      // Conflict — re-fetch and retry
      await this.load();
      // Merge: our data wins (last-write-wins)
      return this.saveRaw(data);
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Save error: ${res.status} ${err.message || ''}`);
    }
    const json = await res.json();
    this.sha = json.content.sha;
  }

  defaultData() {
    const floors = [{ id: 'floor-1', name: 'Floor 1', order: 0 }];
    const rooms = [];
    for (let i = 1; i <= 30; i++) {
      rooms.push({
        id: `room-${i}`,
        name: `Room ${i}`,
        floorId: 'floor-1',
        order: i - 1,
      });
    }
    return { floors, rooms, bookings: [], recurringRules: [], pin: '' };
  }
}

// ===== APP STATE =====
let store = null;
let data = null;
let currentFloorId = 'floor-1';
let currentRoomId = null;
let selectedDate = new Date();
let editingBookingId = null;
let deletingBooking = null;
let nowTimer = null;

// ===== UTILITY =====
function $(id) { return document.getElementById(id); }
function show(id) { $(id).style.display = ''; }
function hide(id) { $(id).style.display = 'none'; }
function genId() { return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }

function formatDate(d) {
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${days[d.getDay()]}, ${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

function dateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function minutesToTime(m) {
  const h = Math.floor(m / 60) % 24;
  const min = m % 60;
  return `${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}`;
}

function formatTimeDisplay(t) {
  const [h, m] = t.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${String(m).padStart(2,'0')} ${ampm}`;
}

function toast(msg) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2500);
}

// ===== GET BOOKINGS FOR A ROOM+DATE =====
function getBookingsForRoomDate(roomId, date) {
  const ds = dateStr(date);
  const dayOfWeek = date.getDay();
  const results = [];

  // One-time bookings
  for (const b of data.bookings) {
    if (b.roomId === roomId && b.date === ds) {
      results.push({ ...b, isRecurring: false });
    }
  }

  // Recurring rules
  for (const r of data.recurringRules) {
    if (r.roomId === roomId && r.daysOfWeek.includes(dayOfWeek)) {
      // Check if there's an exception for this date
      const exceptions = r.exceptions || [];
      if (!exceptions.includes(ds)) {
        results.push({
          id: `${r.id}__${ds}`,
          ruleId: r.id,
          roomId: r.roomId,
          title: r.doctorName,
          details: `Recurring: ${r.daysOfWeek.map(d => ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d]).join(', ')}`,
          startTime: r.startTime,
          endTime: r.endTime,
          date: ds,
          isRecurring: true,
        });
      }
    }
  }

  return results.sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));
}

function getCurrentOccupant(roomId) {
  const now = new Date();
  const bookings = getBookingsForRoomDate(roomId, now);
  const nowMins = now.getHours() * 60 + now.getMinutes();
  for (const b of bookings) {
    if (timeToMinutes(b.startTime) <= nowMins && timeToMinutes(b.endTime) > nowMins) {
      return b;
    }
  }
  return null;
}

// ===== RENDER: MAIN GRID =====
function renderGrid() {
  const grid = $('room-grid');
  const floorRooms = data.rooms
    .filter(r => r.floorId === currentFloorId)
    .sort((a, b) => a.order - b.order);

  $('grid-date-display').textContent = formatDate(new Date());

  grid.innerHTML = floorRooms.map(room => {
    const occupant = getCurrentOccupant(room.id);
    const isOccupied = !!occupant;
    const bookings = getBookingsForRoomDate(room.id, new Date());

    // Build mini-timeline blocks
    let miniBlocks = '';
    const now = new Date();
    const nowMins = now.getHours() * 60 + now.getMinutes();

    for (const b of bookings) {
      const start = timeToMinutes(b.startTime);
      const end = timeToMinutes(b.endTime);
      const leftPct = (start / 1440) * 100;
      const widthPct = ((end - start) / 1440) * 100;
      const isCurrent = start <= nowMins && end > nowMins;
      miniBlocks += `<div class="mini-block${isCurrent ? ' current' : ''}" style="left:${leftPct}%;width:${widthPct}%"></div>`;
    }

    // Now-line
    const nowPct = (nowMins / 1440) * 100;
    miniBlocks += `<div class="mini-now-line" style="left:${nowPct}%"></div>`;

    return `
      <div class="room-card ${isOccupied ? 'occupied' : 'available'}" data-room-id="${room.id}">
        <div class="room-card-header">
          <span class="room-card-name">${room.name}</span>
          <span class="room-card-status ${isOccupied ? 'status-occupied' : 'status-available'}">
            ${isOccupied ? 'In Use' : 'Open'}
          </span>
        </div>
        <div class="room-card-occupant">${isOccupied ? occupant.title : ''}</div>
        <div class="mini-timeline">${miniBlocks}</div>
      </div>
    `;
  }).join('');

  // Click handlers
  grid.querySelectorAll('.room-card').forEach(card => {
    card.addEventListener('click', () => openRoom(card.dataset.roomId));
  });
}

function renderFloorTabs() {
  const tabs = $('floor-tabs');
  tabs.innerHTML = data.floors
    .sort((a, b) => a.order - b.order)
    .map(f => `<button class="floor-tab ${f.id === currentFloorId ? 'active' : ''}" data-floor-id="${f.id}">${f.name}</button>`)
    .join('');

  tabs.querySelectorAll('.floor-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      currentFloorId = btn.dataset.floorId;
      renderFloorTabs();
      renderGrid();
    });
  });
}

// ===== RENDER: ROOM CALENDAR =====
function openRoom(roomId) {
  currentRoomId = roomId;
  selectedDate = new Date();
  hide('grid-view');
  show('room-view');
  renderRoom();
}

function renderRoom() {
  const room = data.rooms.find(r => r.id === currentRoomId);
  if (!room) return;

  $('room-title').textContent = room.name;
  $('room-date-display').textContent = formatDate(selectedDate);

  // Time column
  const timeCol = $('time-column');
  timeCol.innerHTML = '';
  for (let h = 0; h < 24; h++) {
    const label = document.createElement('div');
    label.className = 'time-label';
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    label.textContent = `${h12} ${ampm}`;
    timeCol.appendChild(label);
  }

  // Events column
  const evCol = $('events-column');
  evCol.innerHTML = '';

  // Hour lines
  for (let h = 0; h < 24; h++) {
    const line = document.createElement('div');
    line.className = 'hour-line';
    line.style.top = `${h * 60}px`;
    evCol.appendChild(line);

    const halfLine = document.createElement('div');
    halfLine.className = 'hour-line half';
    halfLine.style.top = `${h * 60 + 30}px`;
    evCol.appendChild(halfLine);
  }

  // Now line (if viewing today)
  const now = new Date();
  if (dateStr(selectedDate) === dateStr(now)) {
    const nowMins = now.getHours() * 60 + now.getMinutes();
    const nowLine = document.createElement('div');
    nowLine.className = 'now-line';
    nowLine.style.top = `${nowMins}px`;
    nowLine.innerHTML = '<div class="now-dot"></div>';
    evCol.appendChild(nowLine);
  }

  // Event blocks
  const bookings = getBookingsForRoomDate(currentRoomId, selectedDate);
  for (const b of bookings) {
    const startMins = timeToMinutes(b.startTime);
    const endMins = timeToMinutes(b.endTime);
    const height = Math.max(endMins - startMins, 15);

    const block = document.createElement('div');
    block.className = `event-block${b.isRecurring ? ' recurring' : ''}`;
    block.style.top = `${startMins}px`;
    block.style.height = `${height}px`;
    block.innerHTML = `
      <div class="event-title">${b.title}</div>
      <div class="event-time">${formatTimeDisplay(b.startTime)} – ${formatTimeDisplay(b.endTime)}</div>
      ${b.details && !b.isRecurring ? `<div class="event-details">${b.details}</div>` : ''}
      ${b.isRecurring ? `<div class="event-details">Recurring office</div>` : ''}
    `;

    block.addEventListener('click', (e) => {
      e.stopPropagation();
      showDeleteModal(b);
    });

    evCol.appendChild(block);
  }

  // Double-click to add
  evCol.addEventListener('dblclick', (e) => {
    if (e.target.closest('.event-block')) return;
    const rect = evCol.getBoundingClientRect();
    const y = e.clientY - rect.top + evCol.parentElement.scrollTop;
    const mins = Math.round(y / 15) * 15;
    openBookingModal(mins);
  });

  // Scroll to ~7am or now
  const container = $('calendar-container');
  if (dateStr(selectedDate) === dateStr(now)) {
    container.scrollTop = Math.max(0, now.getHours() * 60 - 60);
  } else {
    container.scrollTop = 7 * 60;
  }
}

// ===== BOOKING MODAL =====
function openBookingModal(startMinutes) {
  editingBookingId = null;
  $('modal-title').textContent = 'New Booking';
  $('booking-title').value = '';
  $('booking-details').value = '';
  $('booking-start').value = minutesToTime(startMinutes || 480);
  $('booking-end').value = minutesToTime((startMinutes || 480) + 60);
  $('booking-recurring').checked = false;
  hide('recurring-options');
  $('recurring-doctor').value = '';
  document.querySelectorAll('.day-btn').forEach(b => b.classList.remove('selected'));
  show('booking-modal');
  $('booking-title').focus();
}

function closeBookingModal() {
  hide('booking-modal');
}

async function saveBooking() {
  const title = $('booking-title').value.trim();
  const details = $('booking-details').value.trim();
  const startTime = $('booking-start').value;
  const endTime = $('booking-end').value;
  const isRecurring = $('booking-recurring').checked;

  if (!title) { toast('Please enter a title'); return; }
  if (!startTime || !endTime) { toast('Please set start and end times'); return; }
  if (timeToMinutes(endTime) <= timeToMinutes(startTime)) { toast('End time must be after start time'); return; }

  if (isRecurring) {
    const doctor = $('recurring-doctor').value.trim();
    const selectedDays = [...document.querySelectorAll('.day-btn.selected')].map(b => Number(b.dataset.day));
    if (!doctor) { toast('Please enter the doctor name'); return; }
    if (selectedDays.length === 0) { toast('Please select at least one day'); return; }

    const rule = {
      id: genId(),
      roomId: currentRoomId,
      doctorName: doctor,
      daysOfWeek: selectedDays,
      startTime,
      endTime,
      exceptions: [],
      createdAt: new Date().toISOString(),
    };
    data.recurringRules.push(rule);
  } else {
    const booking = {
      id: genId(),
      roomId: currentRoomId,
      title,
      details,
      date: dateStr(selectedDate),
      startTime,
      endTime,
      createdAt: new Date().toISOString(),
    };
    data.bookings.push(booking);
  }

  closeBookingModal();
  renderRoom();
  toast('Booking saved');

  try {
    await store.save(data);
  } catch (err) {
    toast('Error saving — please retry');
    console.error(err);
  }
}

// ===== DELETE MODAL =====
function showDeleteModal(booking) {
  deletingBooking = booking;
  $('delete-confirm-text').textContent = `Delete "${booking.title}"?`;

  if (booking.isRecurring) {
    show('delete-recurring-options');
  } else {
    hide('delete-recurring-options');
  }

  show('delete-modal');
}

function closeDeleteModal() {
  hide('delete-modal');
  deletingBooking = null;
}

async function confirmDelete() {
  if (!deletingBooking) return;

  if (deletingBooking.isRecurring) {
    const scope = document.querySelector('input[name="delete-scope"]:checked').value;
    const rule = data.recurringRules.find(r => r.id === deletingBooking.ruleId);
    if (rule) {
      if (scope === 'all') {
        data.recurringRules = data.recurringRules.filter(r => r.id !== deletingBooking.ruleId);
      } else {
        // Add exception for this date
        if (!rule.exceptions) rule.exceptions = [];
        rule.exceptions.push(deletingBooking.date);
      }
    }
  } else {
    data.bookings = data.bookings.filter(b => b.id !== deletingBooking.id);
  }

  closeDeleteModal();
  renderRoom();
  toast('Booking deleted');

  try {
    await store.save(data);
  } catch (err) {
    toast('Error saving — please retry');
    console.error(err);
  }
}

// ===== SETTINGS =====
function openSettings() {
  renderSettingsFloors();
  renderSettingsRooms();
  $('settings-floor-name').textContent = data.floors.find(f => f.id === currentFloorId)?.name || '';
  show('settings-modal');
}

function closeSettings() {
  hide('settings-modal');
}

function renderSettingsFloors() {
  const list = $('floor-list');
  list.innerHTML = data.floors
    .sort((a, b) => a.order - b.order)
    .map(f => `
      <div class="settings-item" data-id="${f.id}">
        <input type="text" value="${f.name}" data-field="name" data-id="${f.id}">
        ${data.floors.length > 1 ? `<button class="delete-btn" data-id="${f.id}">&times;</button>` : ''}
      </div>
    `).join('');

  list.querySelectorAll('input').forEach(input => {
    input.addEventListener('change', async () => {
      const floor = data.floors.find(f => f.id === input.dataset.id);
      if (floor) floor.name = input.value.trim();
      renderFloorTabs();
      $('settings-floor-name').textContent = data.floors.find(f => f.id === currentFloorId)?.name || '';
      await store.save(data);
    });
  });

  list.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this floor and all its rooms?')) return;
      const id = btn.dataset.id;
      data.floors = data.floors.filter(f => f.id !== id);
      data.rooms = data.rooms.filter(r => r.floorId !== id);
      data.bookings = data.bookings.filter(b => {
        const room = data.rooms.find(r => r.id === b.roomId);
        return room;
      });
      data.recurringRules = data.recurringRules.filter(r => {
        const room = data.rooms.find(rm => rm.id === r.roomId);
        return room;
      });
      if (currentFloorId === id) currentFloorId = data.floors[0]?.id || '';
      renderSettingsFloors();
      renderFloorTabs();
      renderGrid();
      await store.save(data);
    });
  });
}

function renderSettingsRooms() {
  const list = $('room-list');
  const floorRooms = data.rooms
    .filter(r => r.floorId === currentFloorId)
    .sort((a, b) => a.order - b.order);

  list.innerHTML = floorRooms.map(r => `
    <div class="settings-item" data-id="${r.id}">
      <input type="text" value="${r.name}" data-id="${r.id}">
      <button class="delete-btn" data-id="${r.id}">&times;</button>
    </div>
  `).join('');

  list.querySelectorAll('input').forEach(input => {
    input.addEventListener('change', async () => {
      const room = data.rooms.find(r => r.id === input.dataset.id);
      if (room) room.name = input.value.trim();
      renderGrid();
      await store.save(data);
    });
  });

  list.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      data.rooms = data.rooms.filter(r => r.id !== id);
      data.bookings = data.bookings.filter(b => b.roomId !== id);
      data.recurringRules = data.recurringRules.filter(r => r.roomId !== id);
      renderSettingsRooms();
      renderGrid();
      await store.save(data);
    });
  });
}

// ===== SETUP & AUTH =====
function showSetup() {
  hide('pin-view');
  hide('grid-view');
  hide('room-view');
  show('setup-view');
}

function showPin() {
  hide('setup-view');
  hide('grid-view');
  hide('room-view');
  show('pin-view');
  $('pin-input').focus();
}

function showGrid() {
  hide('setup-view');
  hide('pin-view');
  hide('room-view');
  show('grid-view');
  renderFloorTabs();
  renderGrid();
  startNowTimer();
}

function showRoomView() {
  hide('setup-view');
  hide('pin-view');
  hide('grid-view');
  show('room-view');
}

function startNowTimer() {
  if (nowTimer) clearInterval(nowTimer);
  nowTimer = setInterval(() => {
    if ($('grid-view').style.display !== 'none') {
      renderGrid();
    }
    if ($('room-view').style.display !== 'none') {
      renderRoom();
    }
  }, 60000); // Update every minute
}

// ===== INIT =====
async function init() {
  const token = localStorage.getItem('gh_token');

  if (!token) {
    showSetup();
    return;
  }

  store = new GitHubStore(token);

  try {
    data = await store.load();
  } catch (err) {
    console.error('Failed to load data:', err);
    toast('Failed to connect to GitHub. Check your token.');
    showSetup();
    return;
  }

  // Set PIN if not set
  if (!data.pin) {
    showSetup();
    return;
  }

  // Check session
  const session = sessionStorage.getItem('pin_ok');
  if (session === 'true') {
    showGrid();
  } else {
    showPin();
  }
}

// ===== EVENT BINDINGS =====
document.addEventListener('DOMContentLoaded', () => {
  // Setup
  $('setup-save-btn').addEventListener('click', async () => {
    const token = $('github-token-input').value.trim();
    const pin = $('setup-pin-input').value.trim();

    // If there's already a token stored, use it
    const existingToken = localStorage.getItem('gh_token') || token;

    if (!existingToken) {
      $('setup-error').textContent = 'Please enter a GitHub token.';
      return;
    }
    if (!pin) {
      $('setup-error').textContent = 'Please enter a PIN.';
      return;
    }

    $('setup-error').textContent = '';
    $('setup-save-btn').textContent = 'Connecting...';
    $('setup-save-btn').disabled = true;

    try {
      localStorage.setItem('gh_token', existingToken);
      store = new GitHubStore(existingToken);
      data = await store.load();
      data.pin = pin;
      await store.save(data);
      sessionStorage.setItem('pin_ok', 'true');
      showGrid();
      toast('Setup complete!');
    } catch (err) {
      console.error(err);
      $('setup-error').textContent = 'Failed to connect. Check your token and try again.';
      localStorage.removeItem('gh_token');
    } finally {
      $('setup-save-btn').textContent = 'Complete Setup';
      $('setup-save-btn').disabled = false;
    }
  });

  // PIN entry
  $('pin-submit-btn').addEventListener('click', () => {
    const pin = $('pin-input').value.trim();
    if (pin === data.pin) {
      sessionStorage.setItem('pin_ok', 'true');
      $('pin-error').textContent = '';
      showGrid();
    } else {
      $('pin-error').textContent = 'Incorrect PIN. Please try again.';
    }
  });

  $('pin-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('pin-submit-btn').click();
  });

  // Back button
  $('back-btn').addEventListener('click', () => {
    currentRoomId = null;
    hide('room-view');
    showGrid();
  });

  // Date navigation
  $('prev-day-btn').addEventListener('click', () => {
    selectedDate.setDate(selectedDate.getDate() - 1);
    renderRoom();
  });

  $('next-day-btn').addEventListener('click', () => {
    selectedDate.setDate(selectedDate.getDate() + 1);
    renderRoom();
  });

  $('today-btn').addEventListener('click', () => {
    selectedDate = new Date();
    renderRoom();
  });

  $('room-date-display').addEventListener('click', () => {
    const picker = $('hidden-date-picker');
    picker.value = dateStr(selectedDate);
    picker.showPicker?.();
    picker.addEventListener('change', function handler() {
      picker.removeEventListener('change', handler);
      const parts = picker.value.split('-');
      selectedDate = new Date(parts[0], parts[1] - 1, parts[2]);
      renderRoom();
    });
  });

  // Add booking button
  $('add-booking-btn').addEventListener('click', () => {
    const now = new Date();
    const mins = now.getHours() * 60 + now.getMinutes();
    const rounded = Math.ceil(mins / 15) * 15;
    openBookingModal(rounded);
  });

  // Booking modal
  $('modal-close-btn').addEventListener('click', closeBookingModal);
  $('modal-cancel-btn').addEventListener('click', closeBookingModal);
  $('modal-save-btn').addEventListener('click', saveBooking);

  $('booking-recurring').addEventListener('change', (e) => {
    if (e.target.checked) {
      show('recurring-options');
      // Auto-fill title with doctor name if recurring
      $('booking-title').placeholder = 'Auto-filled from doctor name';
    } else {
      hide('recurring-options');
      $('booking-title').placeholder = 'e.g., Dr. Smith, Patient Visit';
    }
  });

  // Update title when doctor name changes (for recurring)
  $('recurring-doctor').addEventListener('input', () => {
    if ($('booking-recurring').checked) {
      $('booking-title').value = $('recurring-doctor').value;
    }
  });

  // Day picker buttons
  document.querySelectorAll('.day-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      btn.classList.toggle('selected');
    });
  });

  // Delete modal
  $('delete-modal-close').addEventListener('click', closeDeleteModal);
  $('delete-cancel-btn').addEventListener('click', closeDeleteModal);
  $('delete-confirm-btn').addEventListener('click', confirmDelete);

  // Sync / Refresh (shared handler)
  async function syncData(btn) {
    btn.style.animation = 'spin 0.6s linear infinite';
    try {
      data = await store.load();
      if ($('grid-view').style.display !== 'none') renderGrid();
      if ($('room-view').style.display !== 'none') renderRoom();
      toast('Synced!');
    } catch (err) {
      toast('Sync failed — check connection');
      console.error(err);
    } finally {
      btn.style.animation = '';
    }
  }
  $('sync-btn').addEventListener('click', () => syncData($('sync-btn')));
  $('room-sync-btn').addEventListener('click', () => syncData($('room-sync-btn')));

  // Settings
  $('settings-btn').addEventListener('click', openSettings);
  $('settings-close-btn').addEventListener('click', () => {
    closeSettings();
    renderGrid();
  });

  $('add-floor-btn').addEventListener('click', async () => {
    const maxOrder = Math.max(0, ...data.floors.map(f => f.order));
    const newFloor = {
      id: genId(),
      name: `Floor ${data.floors.length + 1}`,
      order: maxOrder + 1,
    };
    data.floors.push(newFloor);
    renderSettingsFloors();
    renderFloorTabs();
    await store.save(data);
  });

  $('add-room-btn').addEventListener('click', async () => {
    const floorRooms = data.rooms.filter(r => r.floorId === currentFloorId);
    const maxOrder = Math.max(0, ...floorRooms.map(r => r.order));
    const newRoom = {
      id: genId(),
      name: `Room ${floorRooms.length + 1}`,
      floorId: currentFloorId,
      order: maxOrder + 1,
    };
    data.rooms.push(newRoom);
    renderSettingsRooms();
    renderGrid();
    await store.save(data);
  });

  $('save-pin-btn').addEventListener('click', async () => {
    const newPin = $('new-pin-input').value.trim();
    if (!newPin) { toast('Please enter a new PIN'); return; }
    data.pin = newPin;
    await store.save(data);
    $('new-pin-input').value = '';
    toast('PIN updated');
  });

  $('reset-config-btn').addEventListener('click', () => {
    if (!confirm('This will clear your GitHub token from this device. You will need to re-enter it.')) return;
    localStorage.removeItem('gh_token');
    sessionStorage.removeItem('pin_ok');
    location.reload();
  });

  // Close modals on overlay click
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        overlay.style.display = 'none';
      }
    });
  });

  // Keyboard shortcut: Escape to close modals
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if ($('booking-modal').style.display !== 'none') closeBookingModal();
      if ($('delete-modal').style.display !== 'none') closeDeleteModal();
      if ($('settings-modal').style.display !== 'none') { closeSettings(); renderGrid(); }
    }
  });

  // Start
  init();
});
