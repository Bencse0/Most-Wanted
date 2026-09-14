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

async function loginHunter() {
    const pin = document.getElementById('hunter-pin').value;
    const res = await fetch('/api/auth/hunter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin })
    });
    if (!res.ok) return showHunterToast('Hibás PIN kód.', 'urgent');
    document.getElementById('login-view').style.display = 'none';
    document.getElementById('hunter-layout').style.display = 'grid';
    initMap();
    startHunterGPS();
    fetchState();
}

function initMap() {
    map = L.map('map', { zoomControl: false }).setView([47.4979, 19.0402], 13);
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap'
    }).addTo(map);
}

function startHunterGPS() {
    if (!navigator.geolocation) {
        document.getElementById('hunter-gps-status').innerText = 'VADÁSZ GPS: NEM TÁMOGATOTT';
        return;
    }
    hunterWatchId = navigator.geolocation.watchPosition(
        (position) => {
            hunterPosition = position;
            document.getElementById('hunter-gps-status').innerText =
                `VADÁSZ GPS: AKTÍV · ±${Math.round(position.coords.accuracy || 0)} m`;
            renderRunners();
        },
        () => {
            document.getElementById('hunter-gps-status').innerText = 'VADÁSZ GPS: NEM ELÉRHETŐ';
        },
        { enableHighAccuracy: settings.high_accuracy_enabled !== false, timeout: 15000, maximumAge: 1000 }
    );
    setInterval(postHunterLocation, 1000);
}

async function postHunterLocation() {
    if (!hunterPosition || hunterPostInFlight) return;
    hunterPostInFlight = true;
    const { coords } = hunterPosition;
    try {
        await fetch('/api/hunter/location', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                latitude: coords.latitude,
                longitude: coords.longitude,
                accuracy: coords.accuracy,
                speed: coords.speed
            })
        });
    } finally {
        hunterPostInFlight = false;
    }
}

async function fetchState() {
    if (stateRequestInFlight) return;
    stateRequestInFlight = true;
    try {
        const res = await fetch('/api/state');
        if (!res.ok) return;
        const data = await res.json();
        settings = data.settings || {};
        runnersData = data.runners || [];
        hunterPresence = data.hunter || null;
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

setInterval(fetchState, 1000);

function fillSettings(nextSettings) {
    document.getElementById('set-interval').value = nextSettings.location_interval || 20;
    document.getElementById('set-live-interval').value = nextSettings.live_update_interval || 1;
    document.getElementById('set-title').value = nextSettings.game_title || '';
    document.getElementById('set-description').value = nextSettings.game_description || '';
    document.getElementById('set-instructions').value = nextSettings.runner_instructions || '';
    document.getElementById('set-announcement').value = nextSettings.announcement || '';
    document.getElementById('set-status').value = nextSettings.game_status || 'waiting';
    document.getElementById('set-priority').value = nextSettings.announcement_priority || 'normal';
    document.getElementById('set-accent').value = nextSettings.accent_color || '#9b87f5';
    document.getElementById('set-distance').checked = nextSettings.distance_enabled !== false;
    document.getElementById('set-speed').checked = nextSettings.speed_enabled !== false;
    document.getElementById('set-alerts').checked = nextSettings.alerts_enabled !== false;
    document.getElementById('set-accuracy').checked = nextSettings.high_accuracy_enabled !== false;
    document.getElementById('set-penalty-enabled').checked = nextSettings.penalty_enabled !== false;
}

function updateStats() {
    const active = runnersData.filter((runner) => !isLate(runner)).length;
    const wanted = runnersData.find((runner) => runner.is_most_wanted);
    document.getElementById('stat-runners').innerText = runnersData.length;
    document.getElementById('stat-active').innerText = active;
    document.getElementById('stat-wanted').innerText = wanted ? wanted.name : '—';
    document.getElementById('stat-hunter-speed').innerText = hunterPosition?.coords?.speed != null
        ? `${toKmh(hunterPosition.coords.speed).toFixed(1)} km/h` : '—';
}

function isLate(runner) {
    return runner.next_location_at && Date.now() > new Date(runner.next_location_at).getTime();
}

function getMapCoordinates(runner) {
    const liveFresh = runner.live_location_at
        && Date.now() - new Date(runner.live_location_at).getTime() < 90000;
    const liveCoordinatesExist = runner.live_latitude !== null && runner.live_longitude !== null;
    const officialCoordinatesExist = runner.last_latitude !== null && runner.last_longitude !== null;
    return liveFresh && liveCoordinatesExist
        ? { lat: Number(runner.live_latitude), lng: Number(runner.live_longitude), live: true }
        : officialCoordinatesExist
            ? { lat: Number(runner.last_latitude), lng: Number(runner.last_longitude), live: false }
            : { lat: null, lng: null, live: false };
}

function renderRunners() {
    const list = document.getElementById('runner-list');
    const activeElement = document.activeElement;
    if (activeElement && list.contains(activeElement)
        && (activeElement.matches('select, input, textarea, button'))) {
        return;
    }
    list.innerHTML = '';
    const runnerIds = new Set(runnersData.map((runner) => runner.id));
    Object.keys(markers).forEach((id) => {
        if (!runnerIds.has(Number(id))) {
            map.removeLayer(markers[id]);
            delete markers[id];
        }
    });
    if (!runnersData.length) {
        list.innerHTML = '<div class="empty-state"><strong>Még nincs menekülő</strong><span>A csatlakozó játékosok itt jelennek meg.</span></div>';
        return;
    }

    runnersData.forEach((runner) => {
        const late = isLate(runner);
        const coords = getMapCoordinates(runner);
        const hasCoords = Number.isFinite(coords.lat) && Number.isFinite(coords.lng);
        const lastTime = runner.last_location_at ? formatDateTime(runner.last_location_at) : 'Még nem küldött';
        const nextTime = runner.next_location_at ? formatDateTime(runner.next_location_at) : '--:--';
        const liveTime = runner.live_location_at ? formatDateTime(runner.live_location_at) : '—';
        let distanceStr = '—';
        if (runner.is_most_wanted && hunterPosition && hasCoords && settings.distance_enabled !== false) {
            const distance = getDistanceInKm(
                hunterPosition.coords.latitude,
                hunterPosition.coords.longitude,
                coords.lat,
                coords.lng
            );
            distanceStr = `${distance.toFixed(2)} km`;
        }
        if (hasCoords) {
            if (!markers[runner.id]) {
                markers[runner.id] = L.marker([coords.lat, coords.lng], {
                    icon: runnerIcon(runner.is_most_wanted, coords.live)
                }).addTo(map);
            } else {
                markers[runner.id].setLatLng([coords.lat, coords.lng]);
                markers[runner.id].setIcon(runnerIcon(runner.is_most_wanted, coords.live));
            }
            markers[runner.id].bindPopup(
                `<b>${escapeHtml(runner.name)}</b><br>${coords.live ? 'Élő GPS' : 'Hivatalos jel'}: ${liveTime}`
            );
        }

        const penaltyActive = runner.penalty_until && new Date(runner.penalty_until).getTime() > Date.now();
        const speed = Number.isFinite(Number(runner.live_speed)) ? `${toKmh(runner.live_speed).toFixed(1)} km/h` : '—';
        const cardClass = `runner-card ${late ? 'late' : 'active'} ${runner.is_most_wanted ? 'most-wanted' : ''}`;
        const mwBadge = runner.is_most_wanted ? '<span class="mw-badge">MOST WANTED</span>' : '';
        const penaltyLabel = penaltyActive ? `Élő követés ${formatDateTime(runner.penalty_until)}-ig` : 'Büntetés nincs aktív';
        const selectedPenalty = String(penaltySelections[runner.id] || 0);
        const action = runner.is_most_wanted
            ? '<button class="small-button danger" onclick="setMostWanted(null)">CÉLPONT LEVÉTELE</button>'
            : '<button class="small-button" onclick="setMostWanted(' + runner.id + ')">MOST WANTED BEÁLLÍTÁSA</button>';

        list.innerHTML += `
            <article class="${cardClass}">
                <div class="runner-card-title">
                    <strong>${escapeHtml(runner.name)} ${mwBadge}</strong>
                    <span class="runner-state ${late ? 'late' : ''}">${late ? 'KÉSÉS' : 'AKTÍV'}</span>
                </div>
                <div class="runner-live-line"><span class="${coords.live ? 'live-dot' : 'muted-dot'}"></span>${coords.live ? 'ÉLŐ GPS' : 'UTOLSÓ HIVATALOS JEL'} · ${liveTime}</div>
                <div class="runner-card-grid">
                    <span>Legutóbbi jel<b>${lastTime}</b></span>
                    <span>Következő jel<b>${nextTime}</b></span>
                    <span>Pontosság<b>${runner.live_accuracy || runner.last_accuracy ? `${Math.round(runner.live_accuracy || runner.last_accuracy)} m` : '—'}</b></span>
                    <span>Távolság a vadásztól<b>${runner.is_most_wanted ? distanceStr : '—'}</b></span>
                    <span>Sebesség<b>${runner.is_most_wanted && settings.speed_enabled !== false ? speed : 'Rejtett'}</b></span>
                    <span>Állapot<b>${penaltyLabel}</b></span>
                </div>
                <div class="runner-actions">
                    ${action}
                    ${settings.penalty_enabled !== false ? `
                        <select id="penalty-${runner.id}" class="penalty-select" aria-label="${escapeHtml(runner.name)} büntetés" onchange="rememberPenaltySelection(${runner.id}, this.value)">
                            <option value="0" ${selectedPenalty === '0' ? 'selected' : ''}>Nincs büntetés</option>
                            ${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((minute) => `<option value="${minute}" ${selectedPenalty === String(minute) ? 'selected' : ''}>${minute} perc folyamatos láthatóság</option>`).join('')}
                        </select>
                        <button class="small-button secondary" onclick="setPenalty(${runner.id})">BÜNTETÉS AKTIVÁLÁSA</button>
                    ` : ''}
                </div>
            </article>
        `;
    });
}

function rememberPenaltySelection(runnerId, value) {
    penaltySelections[runnerId] = value;
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
    await fetch('/api/hunter/most-wanted', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runner_id: id })
    });
    fetchState();
}

async function setPenalty(runnerId) {
    const minutes = Number(document.getElementById(`penalty-${runnerId}`).value);
    const res = await fetch('/api/hunter/penalty', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runner_id: runnerId, minutes })
    });
    if (!res.ok) return showHunterToast('A büntetés aktiválása nem sikerült.', 'urgent');
    document.activeElement?.blur();
    showHunterToast(minutes ? `A folyamatos láthatóság ${minutes} percre aktív.` : 'A büntetés törölve.', 'normal');
    fetchState();
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
    const input = document.getElementById('global-msg');
    const message = input.value.trim();
    if (!message) return;
    const res = await fetch('/api/hunter/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            message,
            priority: document.getElementById('message-priority').value
        })
    });
    if (res.ok) {
        input.value = '';
        showHunterToast('Üzenet elküldve minden menekülőnek.', 'normal');
        fetchState();
    }
}

async function resetGame() {
    if (!confirm('Biztosan teljesen újraindítod a játékot? A játékosok, helyzetek, üzenetek és események törlődnek.')) return;
    if (!confirm('Ez a művelet nem vonható vissza. Folytatod?')) return;
    const res = await fetch('/api/hunter/reset', { method: 'POST' });
    if (res.ok) {
        settingsLoaded = false;
        await fetchState();
        showHunterToast('A játék teljesen újraindult.', 'normal');
    } else {
        showHunterToast('A reset nem sikerült.', 'urgent');
    }
}

function renderEventLog(events) {
    document.getElementById('event-log').innerHTML = events
        .map((event) => `<div><time>${formatDateTime(event.created_at)}</time> ${escapeHtml(event.data)}</div>`)
        .join('');
}

function showHunterToast(message, priority) {
    const toast = document.getElementById('hunter-toast');
    toast.innerText = message;
    toast.className = `hunter-toast visible priority-${priority}`;
    clearTimeout(showHunterToast.timer);
    showHunterToast.timer = setTimeout(() => toast.classList.remove('visible'), 5000);
}

function getDistanceInKm(lat1, lon1, lat2, lon2) {
    const earthRadius = 6371;
    const toRadians = (value) => Number(value) * Math.PI / 180;
    const dLat = toRadians(lat2 - lat1);
    const dLon = toRadians(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
    return earthRadius * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function toKmh(metersPerSecond) {
    return Number(metersPerSecond) * 3.6;
}

function formatDateTime(value) {
    if (!value) return '--:--';
    return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
    }[char]));
}