let map;
const markers = {};
let runnersData = [];
let hunterPresence = null;
let settings = {};
let hunterPosition = null;
let hunterWatchId = null;
let hunterPostInFlight = false;
let stateRequestInFlight = false;
let settingsLoaded = false;
const penaltySelections = {};
let penaltyMenuOpen = false;

let stateTimer = null;
let locationTimer = null;
let currentHunterLiveIntervalMs = null;

async function safeJson(res) { try { return await res.json(); } catch { return {}; } }

function resetHunterTimers() {
  const seconds = Number(settings.live_update_interval) || 1;
  const ms = Math.max(seconds, 1) * 1000;
  if (currentHunterLiveIntervalMs === ms) return;
  currentHunterLiveIntervalMs = ms;

  if (stateTimer) clearInterval(stateTimer);
  if (locationTimer) clearInterval(locationTimer);

  stateTimer = setInterval(fetchState, ms);
  locationTimer = setInterval(postHunterLocation, ms);
}

async function loginHunter() {
  const pin = document.getElementById('hunter-pin').value;
  const res = await fetch('/api/auth/hunter', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }) });
  if (!res.ok) return showHunterToast('Hibás PIN kód.', 'urgent');
  document.getElementById('login-view').style.display = 'none';
  document.getElementById('hunter-layout').style.display = 'grid';
  initMap();
  startHunterGPS();
  fetchState();
}

function initMap() {
  map = L.map('map', { zoomControl: false }).setView([47.897, 20.284], 13);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap' }).addTo(map);
}

function startHunterGPS() {
  if (!navigator.geolocation) {
    document.getElementById('hunter-gps-status').innerText = 'VADÁSZ GPS: NEM TÁMOGATOTT';
    return;
  }
  hunterWatchId = navigator.geolocation.watchPosition((position) => {
    hunterPosition = position;
    document.getElementById('hunter-gps-status').innerText = `VADÁSZ GPS: AKTÍV · ±${Math.round(position.coords.accuracy || 0)} m`;
    updateOwnHunterSpeed();
  }, () => {
    document.getElementById('hunter-gps-status').innerText = 'VADÁSZ GPS: NEM ELÉRHETŐ';
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 1000 });

  resetHunterTimers();
}

function updateOwnHunterSpeed() {
  const s = hunterPosition?.coords?.speed;
  document.getElementById('stat-hunter-speed').innerText = Number.isFinite(s) ? `${toKmh(s).toFixed(1)} km/h` : '—';
}

async function postHunterLocation() {
  if (!hunterPosition || hunterPostInFlight) return;
  hunterPostInFlight = true;
  const c = hunterPosition.coords;
  try {
    const res = await fetch('/api/hunter/location', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ latitude: c.latitude, longitude: c.longitude, accuracy: c.accuracy, speed: c.speed })
    });
    if (res.status === 401) location.reload();
  } catch {} finally {
    hunterPostInFlight = false;
  }
}

async function fetchState() {
  if (stateRequestInFlight) return;
  stateRequestInFlight = true;
  try {
    const res = await fetch('/api/state', { cache: 'no-store' });
    if (res.status === 401) return;
    if (!res.ok) return;
    const data = await safeJson(res);
    settings = data.settings || {};
    runnersData = data.runners || [];
    hunterPresence = data.hunter || null;

    resetHunterTimers();

    document.documentElement.style.setProperty('--accent', settings.accent_color || '#9b87f5');
    if (!settingsLoaded) {
      fillSettings(settings);
      settingsLoaded = true;
    }
    updateStats();
    renderRunners();
    renderEventLog(data.events || []);
  } finally {
    stateRequestInFlight = false;
  }
}

function fillSettings(s) {
  document.getElementById('set-interval').value = s.location_interval || 20;
  document.getElementById('set-live-interval').value = s.live_update_interval || 1;
  document.getElementById('set-title').value = s.game_title || '';
  document.getElementById('set-description').value = s.game_description || '';
  document.getElementById('set-instructions').value = s.runner_instructions || '';
  document.getElementById('set-announcement').value = s.announcement || '';
  document.getElementById('set-status').value = s.game_status || 'waiting';
  document.getElementById('set-priority').value = s.announcement_priority || 'normal';
  document.getElementById('set-accent').value = s.accent_color || '#9b87f5';
  document.getElementById('set-distance').checked = s.distance_enabled !== false;
  document.getElementById('set-speed').checked = s.speed_enabled !== false;
  document.getElementById('set-alerts').checked = s.alerts_enabled !== false;
  document.getElementById('set-accuracy').checked = s.high_accuracy_enabled !== false;
  document.getElementById('set-penalty-enabled').checked = s.penalty_enabled !== false;
}

function updateStats() {
  const active = runnersData.filter(r => !isLate(r)).length;
  const wanted = runnersData.find(r => r.is_most_wanted);
  document.getElementById('stat-runners').innerText = runnersData.length;
  document.getElementById('stat-active').innerText = active;
  document.getElementById('stat-wanted').innerText = wanted ? wanted.name : '—';
  updateOwnHunterSpeed();
}

function isLate(r) { return r.next_location_at && Date.now() > new Date(r.next_location_at).getTime(); }
function isPenaltyActive(r) { return r.penalty_until && new Date(r.penalty_until).getTime() > Date.now(); }

function getMapCoordinates(r) {
  const penalty = isPenaltyActive(r);
  if (penalty && Number.isFinite(Number(r.live_latitude)) && Number.isFinite(Number(r.live_longitude))) {
    return { lat: Number(r.live_latitude), lng: Number(r.live_longitude), live: true };
  }
  if (Number.isFinite(Number(r.last_latitude)) && Number.isFinite(Number(r.last_longitude))) {
    return { lat: Number(r.last_latitude), lng: Number(r.last_longitude), live: false };
  }
  return { lat: null, lng: null, live: false };
}

function ensureMarker(r, coords) {
  if (!Number.isFinite(coords.lat) || !Number.isFinite(coords.lng)) return;
  if (!markers[r.id]) {
    markers[r.id] = L.marker([coords.lat, coords.lng], { icon: runnerIcon(r.is_most_wanted, coords.live) }).addTo(map);
  } else {
    markers[r.id].setLatLng([coords.lat, coords.lng]);
    markers[r.id].setIcon(runnerIcon(r.is_most_wanted, coords.live));
  }
  markers[r.id].bindPopup(`<b>${escapeHtml(r.name)}</b><br>${coords.live ? 'Élő GPS' : 'Hivatalos jel'} · ${formatDateTime(coords.live ? r.live_location_at : r.last_location_at)}`);
}

function renderRunners() {
  if (penaltyMenuOpen) return;
  const list = document.getElementById('runner-list');
  const active = document.activeElement;
  if (active && list.contains(active) && (active.matches('select,input,textarea,button'))) return;
  const ids = new Set(runnersData.map(r => Number(r.id)));
  Object.keys(markers).forEach(id => {
    if (!ids.has(Number(id))) {
      map.removeLayer(markers[id]);
      delete markers[id];
    }
  });
  if (!runnersData.length) {
    list.innerHTML = '<div class="empty-state"><strong>Még nincs menekülő</strong><span>A csatlakozó játékosok itt jelennek meg.</span></div>';
    return;
  }
  list.innerHTML = runnersData.map(r => {
    const late = isLate(r), penalty = isPenaltyActive(r), coords = getMapCoordinates(r);
    ensureMarker(r, coords);
    const last = r.last_location_at ? formatDateTime(r.last_location_at) : 'Még nem küldött';
    const next = r.next_location_at ? formatDateTime(r.next_location_at) : '--:--';
    const displayDistance = r.is_most_wanted && Number.isFinite(Number(r.most_wanted_distance_km)) ? `${Number(r.most_wanted_distance_km).toFixed(2)} km` : '—';
    const displaySpeed = r.is_most_wanted && settings.speed_enabled !== false && Number.isFinite(Number(r.most_wanted_speed)) ? `${toKmh(r.most_wanted_speed).toFixed(1)} km/h` : (r.is_most_wanted ? '—' : 'Rejtett');
    const badge = r.is_most_wanted ? '<span class="mw-badge">MOST WANTED</span>' : '';
    const selected = String(penaltySelections[r.id] || 0);
    const action = r.is_most_wanted ? `<button class="small-button danger" onclick="setMostWanted(null)">CÉLPONT LEVÉTELE</button>` : `<button class="small-button" onclick="setMostWanted(${r.id})">MOST WANTED BEÁLLÍTÁSA</button>`;
    return `<article class="runner-card ${late ? 'late' : 'active'} ${r.is_most_wanted ? 'most-wanted' : ''}">
      <div class="runner-card-title"><strong>${escapeHtml(r.name)} ${badge}</strong><span class="runner-state ${late ? 'late' : ''}">${late ? 'KÉSÉS' : 'AKTÍV'}</span></div>
      <div class="runner-live-line"><span class="${coords.live ? 'live-dot' : 'muted-dot'}"></span>${coords.live ? 'ÉLŐ GPS' : 'UTOLSÓ HIVATALOS JEL'} · ${coords.live ? formatDateTime(r.live_location_at) : last}</div>
      <div class="runner-card-grid">
        <span>Legutóbbi jel<b>${last}</b></span><span>Következő jel<b>${next}</b></span>
        <span>Pontosság<b>${(r.live_accuracy || r.last_accuracy) ? `${Math.round(r.live_accuracy || r.last_accuracy)} m` : '—'}</b></span>
        <span>Távolság a vadásztól<b>${r.is_most_wanted ? displayDistance : '—'}</b></span>
        <span>Sebesség<b>${displaySpeed}</b></span>
        <span>Állapot<b>${penalty ? `Élő követés ${formatDateTime(r.penalty_until)}-ig` : 'Büntetés nincs aktív'}</b></span>
      </div>
      <div class="runner-actions">${action}${settings.penalty_enabled !== false ? `<select id="penalty-${r.id}" class="penalty-select" aria-label="${escapeHtml(r.name)} büntetés"><option value="0" ${selected === '0' ? 'selected' : ''}>Nincs büntetés</option>${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(m => `<option value="${m}" ${selected === String(m) ? 'selected' : ''}>${m} perc folyamatos láthatóság</option>`).join('')}</select><button class="small-button secondary" onclick="setPenalty(${r.id})">BÜNTETÉS AKTIVÁLÁSA</button>` : ''}</div>
    </article>`;
  }).join('');
  list.querySelectorAll('.penalty-select').forEach(select => {
    select.addEventListener('focus', () => penaltyMenuOpen = true);
    select.addEventListener('change', () => { penaltySelections[Number(select.id.replace('penalty-', ''))] = select.value; penaltyMenuOpen = false; });
    select.addEventListener('blur', () => setTimeout(() => penaltyMenuOpen = false, 150));
  });
}

function runnerIcon(isWanted, live) {
  return L.divIcon({
    className: 'runner-pin-wrap',
    html: `<span class="runner-pin ${isWanted ? 'wanted' : ''} ${live ? 'live' : ''}"></span>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
    popupAnchor: [0, -12]
  });
}

async function setMostWanted(id) {
  const res = await fetch('/api/hunter/most-wanted', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runner_id: id })
  });
  if (!res.ok) return showHunterToast('A Most Wanted beállítása nem sikerült.', 'urgent');
  await fetchState();
}

async function setPenalty(runnerId) {
  const select = document.getElementById(`penalty-${runnerId}`);
  if (!select) return;
  const minutes = Number(select.value);
  penaltySelections[runnerId] = String(minutes);
  const res = await fetch('/api/hunter/penalty', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runner_id: runnerId, minutes })
  });
  if (!res.ok) {
    const d = await safeJson(res);
    return showHunterToast(d.error || 'A büntetés aktiválása nem sikerült.', 'urgent');
  }
  penaltyMenuOpen = false;
  showHunterToast(minutes ? `A folyamatos láthatóság ${minutes} percre aktív.` : 'A büntetés törölve.', 'normal');
  await fetchState();
}

async function updateSettings() {
  const res = await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      location_interval: Number(document.getElementById('set-interval').value),
      live_update_interval: Number(document.getElementById('set-live-interval').value),
      game_title: document.getElementById('set-title').value,
      game_description: document.getElementById('set-description').value,
      runner_instructions: document.getElementById('set-instructions').value,
      announcement: document.getElementById('set-announcement').value,
      announcement_priority: document.getElementById('set-priority').value,
      game_status: document.getElementById('set-status').value,
      distance_enabled: document.getElementById('set-distance').checked,
      speed_enabled: document.getElementById('set-speed').checked,
      alerts_enabled: document.getElementById('set-alerts').checked,
      high_accuracy_enabled: document.getElementById('set-accuracy').checked,
      penalty_enabled: document.getElementById('set-penalty-enabled').checked,
      accent_color: document.getElementById('set-accent').value
    })
  });
  if (!res.ok) return showHunterToast('A beállítások mentése nem sikerült.', 'urgent');
  settingsLoaded = false;
  await fetchState();
  showHunterToast('A beállítások mentve.', 'normal');
}

async function sendGlobalMsg() {
  const input = document.getElementById('global-msg'), message = input.value.trim();
  if (!message) return;
  const res = await fetch('/api/hunter/message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, priority: document.getElementById('message-priority').value })
  });
  if (res.ok) {
    input.value = '';
    showHunterToast('Üzenet elküldve minden menekülőnek.', 'normal');
    await fetchState();
  }
}

async function resetGame() {
  if (!confirm('Biztosan teljesen újraindítod a játékot?')) return;
  if (!confirm('Ez a művelet nem vonható vissza. Folytatod?')) return;
  const res = await fetch('/api/hunter/reset', { method: 'POST' });
  if (res.ok) {
    settingsLoaded = false;
    await fetchState();
    showHunterToast('A játék teljesen újraindult.', 'normal');
  }
}

function renderEventLog(events) {
  document.getElementById('event-log').innerHTML = events.map(e => `<div><time>${formatDateTime(e.created_at)}</time> ${escapeHtml(e.data)}</div>`).join('');
}

function showHunterToast(message, priority) {
  const toast = document.getElementById('hunter-toast');
  toast.innerText = message;
  toast.className = `hunter-toast visible priority-${priority}`;
  clearTimeout(showHunterToast.timer);
  showHunterToast.timer = setTimeout(() => toast.classList.remove('visible'), 5000);
}

function getDistanceInKm(lat1, lon1, lat2, lon2) {
  const R = 6371, toRad = v => Number(v) * Math.PI / 180, dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1), a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function toKmh(v) { return Number(v) * 3.6; }
function formatDateTime(v) { if (!v) return '--:--'; const d = new Date(v); return Number.isNaN(d.getTime()) ? '--:--' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
function escapeHtml(v) { return String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c])); }

// Initial start
stateTimer = setInterval(fetchState, 1000);
