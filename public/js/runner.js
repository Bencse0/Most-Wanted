let token = sessionStorage.getItem('runnerToken') || localStorage.getItem('runnerToken');
let settings = {};
let runner = null;
let hunter = null;
let intervalMinutes = 20;
let nextLocationAt = null;
let lastLocationTime = null;
let latestPosition = null;
let locationInFlight = false;
let liveInFlight = false;
let lastLiveSentAt = 0;
let retryAfter = 0;
let timersStarted = false;
let audioContext = null;
let titleFlashTimer = null;
let runnerStateInitialized = false;
let watchId = null;
let lastAnnouncement = '';
let lastAnnouncementPriority = '';
const shownMessageIds = new Set();

if (token) {
  sessionStorage.setItem('runnerToken', token);
  localStorage.removeItem('runnerToken');
}

const loginView = document.getElementById('login-view');
const dashView = document.getElementById('dashboard-view');
if (token) loadDashboard();

async function safeJson(res) {
  try { return await res.json(); } catch { return {}; }
}

async function joinGame() {
  const gameCode = document.getElementById('game-code').value.trim();
  const name = document.getElementById('runner-name').value.trim();
  try {
    const res = await fetch('/api/auth/runner', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ gameCode, name }) });
    const data = await safeJson(res);
    if (!res.ok || !data.token) return showAlert(data.error || 'Nem sikerült csatlakozni.', 'urgent');
    sessionStorage.setItem('runnerToken', data.token);
    token = data.token;
    await loadDashboard();
  } catch { showAlert('Nem sikerült kapcsolódni a szerverhez.', 'urgent'); }
}

async function loadDashboard() {
  try {
    const res = await fetch('/api/runner/me', { headers: { Authorization: token }, cache: 'no-store' });
    const data = await safeJson(res);
    if (res.status === 401) return clearRunnerSession();
    if (!res.ok) return showAlert(data.error || 'A játékosadatok betöltése nem sikerült.', 'urgent');
    loginView.style.display = 'none';
    dashView.style.display = 'block';
    applySettings(data.settings);
    applyRunner(data.runner);
    startGeolocation();
    if (!timersStarted) {
      timersStarted = true;
      setInterval(updateTimer, 1000);
      runDynamicLiveLoop();
    }
    await pollRunnerUpdates();
    updateTimer();
    if (!data.runner.last_location_at) sendTimedLocation();
  } catch { showAlert('A szerver nem érhető el.', 'urgent'); }
}

function applySettings(nextSettings) {
  if (!nextSettings) return;
  settings = nextSettings;
  intervalMinutes = Number(settings.location_interval) || 20;
  document.documentElement.style.setProperty('--accent', settings.accent_color || '#9b87f5');
  document.getElementById('r-interval').innerText = `${intervalMinutes} perc`;
  document.getElementById('r-game-title').innerText = settings.game_title || 'Most Wanted - A hajsza';
  document.getElementById('r-game-description').innerText = settings.game_description || '';
  document.getElementById('r-instructions').innerText = settings.runner_instructions || '';
  document.getElementById('r-announcement').innerText = settings.announcement || 'Nincs új közlemény.';
  document.getElementById('r-game-status').innerText = statusLabel(settings.game_status);
  const priority = settings.announcement_priority || 'normal';
  document.getElementById('r-announcement-card').className = `announcement-card priority-${priority}`;
  if (lastAnnouncement !== '' && settings.alerts_enabled && (lastAnnouncement !== settings.announcement || lastAnnouncementPriority !== priority) && settings.announcement) showAlert(settings.announcement, priority, 'system');
  lastAnnouncement = settings.announcement || '';
  lastAnnouncementPriority = priority;
}

function applyRunner(nextRunner) {
  if (!nextRunner) return;
  const wasMostWanted = runner?.is_most_wanted === true;
  runner = nextRunner;
  const isMostWanted = runner?.is_most_wanted === true;
  document.body.classList.toggle('runner-most-wanted', isMostWanted);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', isMostWanted ? '#120a06' : '#0b0d12');
  if (runnerStateInitialized && !wasMostWanted && isMostWanted && settings.alerts_enabled !== false) {
    lastLiveSentAt = 0;
    showAlert('MOST WANTED státusz: a vadászok kiemelten keresnek.', 'urgent', 'most-wanted');
  }
  runnerStateInitialized = true;
  if (!wasMostWanted && isMostWanted) lastLiveSentAt = 0;
  lastLocationTime = runner.last_location_at ? new Date(runner.last_location_at).getTime() : null;
  nextLocationAt = runner.next_location_at ? new Date(runner.next_location_at).getTime() : null;
  document.getElementById('r-name').innerText = runner.name || 'MENEKÜLŐ';
  document.getElementById('r-last').innerText = formatDateTime(lastLocationTime);
  document.getElementById('r-next').innerText = formatDateTime(nextLocationAt);
  const activePenalty = runner.penalty_until && new Date(runner.penalty_until).getTime() > Date.now();
  document.getElementById('r-penalty').innerText = activePenalty ? `FOLYAMATOS LÁTHATÓSÁG · ${formatDateTime(runner.penalty_until)}-IG` : 'IDŐZÍTETT KÖVETÉS';
  document.getElementById('r-penalty').classList.toggle('active', activePenalty);
}

async function runDynamicLiveLoop() {
  while (timersStarted && token) {
    await Promise.allSettled([pollRunnerUpdates(), sendLiveMetrics()]);
    const seconds = Math.max(1, Number(settings.live_update_interval) || 1);
    await new Promise(resolve => setTimeout(resolve, seconds * 1000));
  }
}

async function pollRunnerUpdates() {
  if (!token || (document.hidden && !isMostWantedActive())) return;
  try {
    const res = await fetch('/api/runner/updates', { headers: { Authorization: token }, cache: 'no-store' });
    const data = await safeJson(res);
    if (res.status === 401) return clearRunnerSession();
    if (!res.ok) return;
    applySettings(data.settings);
    const beforePenalty = runner?.penalty_until;
    applyRunner(data.runner);
    hunter = data.hunter;
    applyHunterStatus();
    (data.messages || []).slice().reverse().forEach((message) => {
      if (!shownMessageIds.has(message.id)) { shownMessageIds.add(message.id); showAlert(message.message, message.priority || 'important'); }
    });
    updateTimer();
    if (beforePenalty && !runner?.penalty_until) document.getElementById('r-live-pill').innerText = 'ONLINE';
  } catch {}
}

function isMostWantedActive() {
  return runner?.is_most_wanted === true;
}
function isPenaltyActive() {
  return !!(runner?.penalty_until && new Date(runner.penalty_until).getTime() > Date.now());
}

function applyHunterStatus() {
  const distance = runner?.last_hunter_distance_km;
  const speed = runner?.last_hunter_speed;
  const at = runner?.last_hunter_location_at;
  document.getElementById('r-hunter-distance').innerText = settings.distance_enabled !== false && Number.isFinite(Number(distance)) ? `${Number(distance).toFixed(2)} km` : 'Nem elérhető';
  document.getElementById('r-hunter-speed').innerText = settings.speed_enabled !== false && Number.isFinite(Number(speed)) ? `${toKmh(speed).toFixed(1)} km/h` : 'Nem elérhető';
  document.getElementById('r-hunter-updated').innerText = at ? `A vadász utolsó mért adata: ${formatDateTime(at)}` : 'A vadász GPS-e még nem aktív.';
}

function updateTimer() {
  const timer = document.getElementById('countdown');
  if (!nextLocationAt) { timer.innerText = '--:--:--'; return; }
  const diff = nextLocationAt - Date.now();
  document.getElementById('r-next').innerText = formatDateTime(nextLocationAt);
  if (diff <= 0) {
    timer.innerText = 'GPS-FRISSÍTÉS';
    timer.classList.add('late');
    if (!locationInFlight && Date.now() >= retryAfter) sendTimedLocation();
    return;
  }
  const totalSeconds = Math.floor(diff / 1000);
  timer.innerText = `${String(Math.floor(totalSeconds/3600)).padStart(2,'0')}:${String(Math.floor((totalSeconds%3600)/60)).padStart(2,'0')}:${String(totalSeconds%60).padStart(2,'0')}`;
  timer.classList.remove('late');
  document.getElementById('r-status').innerText = 'IDŐZÍTETT';
  document.getElementById('r-status-detail').innerText = 'A hivatalos helyzetjelzés automatikusan indul a számláló lejártakor.';
  const activePenalty = runner?.penalty_until && new Date(runner.penalty_until).getTime() > Date.now();
  const wanted = runner?.is_most_wanted === true;
  document.getElementById('r-live-pill').innerText = wanted ? 'MOST WANTED' : (activePenalty ? 'ÉLŐ GPS' : 'ONLINE');
  document.getElementById('r-live-pill').classList.toggle('warning', false);
}

function startGeolocation() {
  if (watchId !== null || !navigator.geolocation) return showAlert('A böngésződ nem támogatja a GPS-t.', 'urgent');
  watchId = navigator.geolocation.watchPosition((position) => {
    latestPosition = position;
    document.getElementById('r-gps').innerText = `GPS AKTÍV · ±${Math.round(position.coords.accuracy || 0)} m`;
    document.getElementById('r-own-speed').innerText = Number.isFinite(position.coords.speed) ? `${toKmh(position.coords.speed).toFixed(1)} km/h` : 'Álló helyzet';
  }, (error) => {
    document.getElementById('r-gps').innerText = 'GPS NEM ELÉRHETŐ';
    showAlert(`GPS-hiba: ${error.message}`, 'urgent');
  }, { enableHighAccuracy: settings.high_accuracy_enabled !== false, timeout: 15000, maximumAge: 1000 });
}

async function sendLiveMetrics() {
  if (!token || (!isMostWantedActive() && !isPenaltyActive()) || !latestPosition || liveInFlight) return;
  const intervalMs = Math.max(1, Number(settings.live_update_interval) || 1) * 1000;
  if (Date.now() - lastLiveSentAt < intervalMs) return;

  liveInFlight = true;
  const { coords } = latestPosition;
  const speed = Number.isFinite(coords.speed) ? coords.speed : null;
  try {
    // The coordinates are sent ONLY to the server-side metric endpoint so it can
    // calculate distance from the hunter's current GPS. They are never used to
    // move the hunter's map marker or exposed as live runner coordinates.
    const res = await fetch('/api/runner/live-metrics', {
      method:'POST',
      headers:{'Content-Type':'application/json', Authorization:token},
      body:JSON.stringify({ latitude: coords.latitude, longitude: coords.longitude, accuracy: coords.accuracy, speed }),
      cache:'no-store'
    });
    if (res.status === 401) return clearRunnerSession();
    if (res.ok) {
      const data = await safeJson(res);
      lastLiveSentAt = Date.now();
      if (data.most_wanted_distance_km != null) {
        runner.most_wanted_distance_km = data.most_wanted_distance_km;
        runner.most_wanted_speed = data.most_wanted_speed;
        runner.most_wanted_updated_at = data.most_wanted_updated_at;
      }
    }
  } catch {} finally { liveInFlight = false; }
}

function getDistanceInKm(lat1,lon1,lat2,lon2){
  const R=6371,toRad=v=>Number(v)*Math.PI/180,dLat=toRad(lat2-lat1),dLon=toRad(lon2-lon1);
  const a=Math.sin(dLat/2)**2+Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return R*(2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a)));
}

function sendTimedLocation() {
  if (locationInFlight || !token) return;
  locationInFlight = true;
  const send = async (position) => {
    try {
      const { coords } = position;
      const res = await fetch('/api/location', { method:'POST', headers:{'Content-Type':'application/json', Authorization:token}, body:JSON.stringify({ latitude:coords.latitude, longitude:coords.longitude, accuracy:coords.accuracy, speed:coords.speed }), cache:'no-store' });
      const data = await safeJson(res);
      if (res.status === 401) return clearRunnerSession();
      if (res.status === 429) { nextLocationAt = new Date(data.next_location_at).getTime(); return; }
      if (!res.ok) return locationFailed(data.error || 'A helyzetküldés nem sikerült.');
      lastLocationTime = new Date(data.last_location_at).getTime();
      nextLocationAt = new Date(data.next_location_at).getTime();
      if (data.hunter) { hunter = data.hunter; applyHunterStatus(); }
      document.getElementById('r-last').innerText = formatDateTime(lastLocationTime);
      document.getElementById('r-next').innerText = formatDateTime(nextLocationAt);
      retryAfter = 0;
      showAlert('A rendszer elküldte az új hivatalos helyzetedet.', 'normal');
      updateTimer();
    } catch { locationFailed('A helyzetküldés nem sikerült.'); }
    finally { locationInFlight = false; }
  };
  if (latestPosition) send(latestPosition);
  else if (navigator.geolocation) navigator.geolocation.getCurrentPosition((p) => { latestPosition = p; send(p); }, (e) => locationFailed(`GPS-hiba: ${e.message}`), { enableHighAccuracy: settings.high_accuracy_enabled !== false, timeout: 15000, maximumAge: 0 });
  else locationFailed('A böngésződ nem támogatja a GPS-t.');
}

function locationFailed(message) {
  locationInFlight = false;
  retryAfter = Date.now() + 30000;
  document.getElementById('r-status').innerText = 'GPS ÚJRA-PRÓBÁLKOZÁS';
  document.getElementById('r-status-detail').innerText = `${message} A rendszer 30 másodperc múlva újrapróbálja.`;
  document.getElementById('r-live-pill').innerText = 'FIGYELEM';
  document.getElementById('r-live-pill').classList.add('warning');
  showAlert(message, 'urgent');
}

function ensureAudioContext() {
  try {
    if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
    return audioContext;
  } catch { return null; }
}
function playAlertTone(priority) {
  const ctx = ensureAudioContext();
  if (!ctx) return;
  const now = ctx.currentTime;
  const count = priority === 'urgent' ? 3 : priority === 'important' ? 2 : 1;
  for (let i = 0; i < count; i++) {
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = priority === 'urgent' ? (i % 2 ? 880 : 660) : (i % 2 ? 740 : 520);
    const t = now + i * 0.16;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(priority === 'urgent' ? 0.16 : 0.11, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t); osc.stop(t + 0.15);
  }
}
function requestNotificationPermission() {
  try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {}); } catch {}
}
function showSystemNotification(message, priority, title) {
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(title || (priority === 'urgent' ? 'Most Wanted · Azonnali' : 'Most Wanted · Fontos'), { body: message, tag: 'most-wanted-alert', renotify: true });
    }
  } catch {}
}
function flashDocumentTitle() {
  clearInterval(titleFlashTimer);
  const base = document.title;
  let on = false, ticks = 0;
  titleFlashTimer = setInterval(() => {
    document.title = (on = !on) ? '⚠ MOST WANTED ⚠' : base;
    if (++ticks >= 12) { clearInterval(titleFlashTimer); document.title = base; }
  }, 500);
}
function showAlert(message, priority='important', kind='message') {
  const box = document.getElementById('alert-banner');
  if (!box) return;
  document.getElementById('alert-title').innerText = kind === 'most-wanted' ? 'MOST WANTED' : priority === 'urgent' ? 'AZONNALI FIGYELEM' : priority === 'important' ? 'FONTOS KÖZLEMÉNY' : 'JÁTÉKÜZENET';
  document.getElementById('alert-body').innerText = message;
  box.className = `alert-banner visible priority-${priority} ${kind}`;
  clearTimeout(showAlert.timer);
  showAlert.timer = setTimeout(() => box.classList.remove('visible'), priority === 'urgent' ? 14000 : priority === 'important' ? 9000 : 7000);
  if (priority !== 'normal' || kind === 'most-wanted') {
    if (navigator.vibrate) navigator.vibrate(priority === 'urgent' || kind === 'most-wanted' ? [180,90,180,90,260] : [120,80,120]);
    playAlertTone(priority === 'normal' ? 'important' : priority);
    flashDocumentTitle();
    showSystemNotification(message, priority, kind === 'most-wanted' ? 'MOST WANTED' : null);
  }
}
document.addEventListener('pointerdown', () => { ensureAudioContext(); requestNotificationPermission(); }, { once: true });
function clearRunnerSession() {
  if (watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchId);
  sessionStorage.removeItem('runnerToken'); localStorage.removeItem('runnerToken'); token = null; location.reload();
}
async function leaveGame() { if (!confirm('Kilépsz ebből a játékból?')) return; await fetch('/api/runner/leave',{method:'POST',headers:{Authorization:token}}).catch(()=>{}); clearRunnerSession(); }
function statusLabel(status) { return ({waiting:'VÁRAKOZÁS',live:'JÁTÉK ÉLŐ',paused:'SZÜNETEL',finished:'LEZÁRVA'})[status] || 'JÁTÉK ÉLŐ'; }
function toKmh(mps) { return Number(mps) * 3.6; }
function formatDateTime(value) { if (!value) return '--:--'; const d = new Date(value); return Number.isNaN(d.getTime()) ? '--:--' : d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'}); }
