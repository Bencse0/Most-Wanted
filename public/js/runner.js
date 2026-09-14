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
let retryAfter = 0;
let timersStarted = false;
let watchId = null;
let lastAnnouncement = '';
let lastAnnouncementPriority = '';
let lastHunterSnapshotKey = '';
const shownMessageIds = new Set();

if (token) {
    sessionStorage.setItem('runnerToken', token);
    localStorage.removeItem('runnerToken');
}

const loginView = document.getElementById('login-view');
const dashView = document.getElementById('dashboard-view');

if (token) loadDashboard();

async function joinGame() {
    const gameCode = document.getElementById('game-code').value.trim();
    const name = document.getElementById('runner-name').value.trim();
    const res = await fetch('/api/auth/runner', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gameCode, name })
    });
    const data = await res.json();
    if (!res.ok || !data.token) {
        showAlert(data.error || 'Nem sikerült csatlakozni.', 'urgent');
        return;
    }
    sessionStorage.setItem('runnerToken', data.token);
    token = data.token;
    loadDashboard();
}

async function loadDashboard() {
    const res = await fetch('/api/runner/me', { headers: { Authorization: token } });
    if (res.status === 401) return clearRunnerSession();
    if (!res.ok) return showAlert('A játékosadatok betöltése nem sikerült.', 'urgent');

    const data = await res.json();
    loginView.style.display = 'none';
    dashView.style.display = 'block';
    applySettings(data.settings);
    applyRunner(data.runner);
    startGeolocation();

    if (!timersStarted) {
        timersStarted = true;
        setInterval(updateTimer, 1000);
        setInterval(pollRunnerUpdates, 1000);
        setInterval(sendLiveLocation, 3000);
    }

    pollRunnerUpdates();
    updateTimer();
    if (!data.runner.last_location_at) sendTimedLocation();
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
    const announcementPriority = settings.announcement_priority || 'normal';
    document.getElementById('r-announcement-card').className =
        `announcement-card priority-${announcementPriority}`;
    if (lastAnnouncement && settings.alerts_enabled
        && (lastAnnouncement !== settings.announcement || lastAnnouncementPriority !== announcementPriority)) {
        showAlert(settings.announcement, announcementPriority);
    }
    lastAnnouncement = settings.announcement || '';
    lastAnnouncementPriority = announcementPriority;
}

function applyRunner(nextRunner) {
    if (!nextRunner) return;
    runner = nextRunner;
    if (runner.last_location_at) {
        lastLocationTime = new Date(runner.last_location_at).getTime();
        document.getElementById('r-last').innerText = formatDateTime(lastLocationTime);
    }
    if (runner.next_location_at) {
        nextLocationAt = new Date(runner.next_location_at).getTime();
        document.getElementById('r-next').innerText = formatDateTime(nextLocationAt);
    }
    document.getElementById('r-name').innerText = runner.name || 'MENEKÜLŐ';
    const penaltyActive = runner.penalty_until && new Date(runner.penalty_until).getTime() > Date.now();
    document.getElementById('r-penalty').innerText = penaltyActive
        ? `FOLYAMATOS LÁTHATÓSÁG · ${formatDateTime(runner.penalty_until)}-IG`
        : 'IDŐZÍTETT KÖVETÉS';
    document.getElementById('r-penalty').classList.toggle('active', Boolean(penaltyActive));
}

async function pollRunnerUpdates() {
    if (!token || document.hidden && !runner?.penalty_until) return;
    const res = await fetch('/api/runner/updates', { headers: { Authorization: token } });
    if (res.status === 401) return clearRunnerSession();
    if (!res.ok) return;

    const data = await res.json();
    applySettings(data.settings);
    applyRunner(data.runner);
    hunter = data.hunter;
    const snapshotKey = `${data.runner?.last_location_at || ''}|${data.runner?.last_hunter_location_at || ''}|${data.runner?.last_hunter_distance_km ?? ''}|${data.runner?.last_hunter_speed ?? ''}`;
    if (snapshotKey !== lastHunterSnapshotKey) {
        lastHunterSnapshotKey = snapshotKey;
        applyHunterStatus();
    }

    (data.messages || []).slice().reverse().forEach((message) => {
        if (!shownMessageIds.has(message.id)) {
            shownMessageIds.add(message.id);
            showAlert(message.message, message.priority || 'important');
        }
    });
    updateTimer();
}

function applyHunterStatus() {
    const distance = runner?.last_hunter_distance_km;
    const speed = runner?.last_hunter_speed;
    const locationAt = runner?.last_hunter_location_at;
    document.getElementById('r-hunter-distance').innerText =
        settings.distance_enabled && Number.isFinite(Number(distance))
            ? `${Number(distance).toFixed(2)} km`
            : 'Nem elérhető';
    document.getElementById('r-hunter-speed').innerText =
        settings.speed_enabled && Number.isFinite(Number(speed))
            ? `${toKmh(speed).toFixed(1)} km/h`
            : 'Nem elérhető';
    document.getElementById('r-hunter-updated').innerText =
        locationAt ? `A te utolsó jelzésedkor: ${formatDateTime(locationAt)}` : 'A vadász GPS-e még nem aktív';
}

function updateTimer() {
    const timer = document.getElementById('countdown');
    if (!nextLocationAt) {
        timer.innerText = '--:--:--';
        return;
    }
    const diff = nextLocationAt - Date.now();
    document.getElementById('r-next').innerText = formatDateTime(nextLocationAt);
    if (diff <= 0) {
        timer.innerText = 'GPS-FRISSÍTÉS';
        timer.classList.add('late');
        document.getElementById('r-status').innerText = locationInFlight ? 'GPS KÜLDÉSE' : 'ESEDÉKES';
        document.getElementById('r-status-detail').innerText =
            'A rendszer most lekéri és elküldi a helyzetedet.';
        document.getElementById('r-live-pill').innerText = 'FRISSÍTÉS';
        document.getElementById('r-live-pill').classList.add('warning');
        if (!locationInFlight && Date.now() >= retryAfter) sendTimedLocation();
        return;
    }

    const totalSeconds = Math.floor(diff / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    timer.innerText = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    timer.classList.remove('late');
    document.getElementById('r-status').innerText = 'IDŐZÍTETT';
    document.getElementById('r-status-detail').innerText =
        'A hivatalos helyzetjelzés automatikusan indul a számláló lejártakor.';
    document.getElementById('r-live-pill').innerText = runner?.live_tracking_required
        ? 'ÉLŐ GPS' : 'ONLINE';
    document.getElementById('r-live-pill').classList.remove('warning');
}

function startGeolocation() {
    if (watchId !== null || !navigator.geolocation) {
        if (!navigator.geolocation) showAlert('A böngésződ nem támogatja a GPS-t.', 'urgent');
        return;
    }
    watchId = navigator.geolocation.watchPosition(
        (position) => {
            latestPosition = position;
            document.getElementById('r-gps').innerText = `GPS AKTÍV · ±${Math.round(position.coords.accuracy || 0)} m`;
            document.getElementById('r-own-speed').innerText = Number.isFinite(position.coords.speed)
                ? `${toKmh(position.coords.speed).toFixed(1)} km/h` : 'Álló helyzet';
        },
        (error) => {
            document.getElementById('r-gps').innerText = 'GPS NEM ELÉRHETŐ';
            showAlert(`GPS-hiba: ${error.message}`, 'urgent');
        },
        {
            enableHighAccuracy: settings.high_accuracy_enabled !== false,
            timeout: 15000,
            maximumAge: 1000
        }
    );
}

async function sendLiveLocation() {
    if (!token || !runner?.live_tracking_required || liveInFlight || !navigator.geolocation) return;
    liveInFlight = true;
    const finish = () => { liveInFlight = false; };
    navigator.geolocation.getCurrentPosition(async (position) => {
        latestPosition = position;
        const { coords } = position;
        try {
            const res = await fetch('/api/runner/live-location', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: token },
                body: JSON.stringify({
                    latitude: coords.latitude,
                    longitude: coords.longitude,
                    accuracy: coords.accuracy,
                    speed: coords.speed
                })
            });
            if (res.status === 401) return clearRunnerSession();
            if (res.status === 403) {
                await pollRunnerUpdates();
                return;
            }
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                showAlert(data.error || 'Az élő helyzetküldés nem sikerült.', 'urgent');
                return;
            }
        } finally {
            finish();
        }
    }, () => {
        finish();
    }, {
        enableHighAccuracy: settings.high_accuracy_enabled !== false,
        timeout: 15000,
        maximumAge: 1000
    });
}

function sendTimedLocation() {
    if (locationInFlight || !token) return;
    locationInFlight = true;
    document.getElementById('r-status').innerText = 'GPS KERESÉSE';
    const send = async (position) => {
        const { coords } = position;
        const res = await fetch('/api/location', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: token },
            body: JSON.stringify({
                latitude: coords.latitude,
                longitude: coords.longitude,
                accuracy: coords.accuracy,
                speed: coords.speed
            })
        });
        const data = await res.json();
        if (res.status === 401) return clearRunnerSession();
        if (res.status === 429) {
            nextLocationAt = new Date(data.next_location_at).getTime();
            return locationFailed('A következő hivatalos jelzés még nem esedékes.');
        }
        if (!res.ok) return locationFailed(data.error || 'A helyzetküldés nem sikerült.');
        lastLocationTime = new Date(data.last_location_at).getTime();
        nextLocationAt = new Date(data.next_location_at).getTime();
        if (data.hunter) {
            hunter = data.hunter;
            applyHunterStatus();
        }
        document.getElementById('r-last').innerText = formatDateTime(lastLocationTime);
        document.getElementById('r-next').innerText = formatDateTime(nextLocationAt);
        locationInFlight = false;
        retryAfter = 0;
        showAlert('A rendszer elküldte az új hivatalos helyzetedet.', 'normal');
        updateTimer();
    };

    if (latestPosition) {
        send(latestPosition).catch(() => locationFailed('A helyzetküldés nem sikerült.'));
    } else if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            (position) => {
                latestPosition = position;
                send(position).catch(() => locationFailed('A helyzetküldés nem sikerült.'));
            },
            (error) => locationFailed(`GPS-hiba: ${error.message}`),
            { enableHighAccuracy: settings.high_accuracy_enabled !== false, timeout: 15000, maximumAge: 0 }
        );
    } else {
        locationFailed('A böngésződ nem támogatja a GPS-t.');
    }
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

function showAlert(message, priority = 'important') {
    const box = document.getElementById('alert-banner');
    const title = document.getElementById('alert-title');
    const body = document.getElementById('alert-body');
    title.innerText = priority === 'urgent' ? 'AZONNALI FIGYELEM' : priority === 'important' ? 'FONTOS KÖZLEMÉNY' : 'JÁTÉKÜZENET';
    body.innerText = message;
    box.className = `alert-banner visible priority-${priority}`;
    clearTimeout(showAlert.timer);
    showAlert.timer = setTimeout(() => box.classList.remove('visible'), priority === 'urgent' ? 12000 : 7000);
    if (priority !== 'normal' && navigator.vibrate) navigator.vibrate([120, 80, 120]);
}

function clearRunnerSession() {
    if (watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchId);
    sessionStorage.removeItem('runnerToken');
    localStorage.removeItem('runnerToken');
    token = null;
    location.reload();
}

async function leaveGame() {
    if (!confirm('Kilépsz ebből a játékból? A játékosod eltűnik a vadász irányítópultjáról.')) return;
    await fetch('/api/runner/leave', {
        method: 'POST',
        headers: { Authorization: token },
        keepalive: true
    }).catch(() => {});
    clearRunnerSession();
}

function statusLabel(status) {
    return ({ waiting: 'VÁRAKOZÁS', live: 'JÁTÉK ÉLŐ', paused: 'SZÜNETEL', finished: 'LEZÁRVA' })[status] || 'JÁTÉK ÉLŐ';
}

function toKmh(metersPerSecond) {
    return Number(metersPerSecond) * 3.6;
}

function formatDateTime(value) {
    if (!value) return '--:--';
    return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}