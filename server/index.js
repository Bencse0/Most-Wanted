require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const db = require('./db');
const { ensureSchema } = require('./schema');

const app = express();
const server = http.createServer(app);

app.use(express.json({ limit: '32kb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public'), { etag: false, maxAge: 0 }));
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate'); next(); });

const finiteNumber = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
const validCoordinate = (value, min, max) => Number.isFinite(Number(value)) && Number(value) >= min && Number(value) <= max;
const distanceInKm = (lat1, lon1, lat2, lon2) => {
  if (![lat1, lon1, lat2, lon2].every((value) => Number.isFinite(Number(value)))) return null;
  const toRadians = (value) => Number(value) * Math.PI / 180;
  const earthRadius = 6371;
  const dLat = toRadians(Number(lat2) - Number(lat1));
  const dLon = toRadians(Number(lon2) - Number(lon1));
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
  return earthRadius * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
};
const getPriority = (value) => ['normal', 'important', 'urgent'].includes(value) ? value : 'normal';
const penaltyActive = (runner) => runner?.penalty_until && new Date(runner.penalty_until).getTime() > Date.now();
const liveTrackingActive = penaltyActive;

const handleAsync = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

let hunterPrevious = null;

async function logEvent(type, runnerId, data) {
  const result = await db.query('INSERT INTO events (type, runner_id, data) VALUES ($1, $2, $3) RETURNING *', [type, runnerId ?? null, data]);
  return result.rows[0];
}

async function getSettings() {
  return (await db.query('SELECT * FROM settings WHERE id = 1')).rows[0];
}

function currentHunterSpeedMetersPerSecond(newLat, newLng, newAt, reportedSpeed) {
  const gpsSpeed = finiteNumber(reportedSpeed);
  if (gpsSpeed !== null && gpsSpeed >= 0 && gpsSpeed < 100) return gpsSpeed;
  if (!hunterPrevious) return null;
  const dt = (newAt.getTime() - hunterPrevious.at.getTime()) / 1000;
  if (dt <= 0 || dt > 120) return null;
  const km = distanceInKm(hunterPrevious.lat, hunterPrevious.lng, newLat, newLng);
  if (km === null) return null;
  return Math.min((km * 1000) / dt, 100);
}

// VALÓS IDEJŰ MOST WANTED SZÁMÍTÁS
async function updateMostWantedMetrics() {
  try {
    const mwResult = await db.query(
      'SELECT id, last_latitude, last_longitude, live_latitude, live_longitude, last_speed, live_speed, penalty_until FROM runners WHERE is_most_wanted = TRUE LIMIT 1'
    );
    const mw = mwResult.rows[0];
    if (!mw) return;

    const hunterResult = await db.query('SELECT latitude, longitude FROM hunter_presence WHERE id = 1');
    const hunter = hunterResult.rows[0];
    if (!hunter || !validCoordinate(hunter.latitude, -90, 90) || !validCoordinate(hunter.longitude, -180, 180)) {
      return;
    }

    const live = penaltyActive(mw);
    const targetLat = (live && mw.live_latitude !== null && mw.live_latitude !== undefined) ? mw.live_latitude : mw.last_latitude;
    const targetLng = (live && mw.live_longitude !== null && mw.live_longitude !== undefined) ? mw.live_longitude : mw.last_longitude;

    if (!validCoordinate(targetLat, -90, 90) || !validCoordinate(targetLng, -180, 180)) {
      return;
    }

    const dist = distanceInKm(targetLat, targetLng, hunter.latitude, hunter.longitude);
    const rawSpeed = (live && mw.live_speed !== null && mw.live_speed !== undefined) ? mw.live_speed : mw.last_speed;
    const speed = finiteNumber(rawSpeed);

    await db.query(
      `UPDATE runners 
       SET most_wanted_distance_km = $1, most_wanted_speed = $2, most_wanted_updated_at = NOW() 
       WHERE id = $3`,
      [dist, speed, mw.id]
    );
  } catch (err) {
    console.error('Hiba a Most Wanted adatok frissítésekor:', err);
  }
}

// AUTH
app.post('/api/auth/runner', handleAsync(async (req, res) => {
  const gameCode = String(req.body.gameCode || '').trim();
  const name = String(req.body.name || '').trim();
  if (!process.env.GAME_CODE || gameCode !== process.env.GAME_CODE) return res.status(401).json({ error: 'Érvénytelen játékkód' });
  if (!name) return res.status(400).json({ error: 'Név megadása kötelező' });

  const token = crypto.randomBytes(24).toString('hex');
  const result = await db.query(
    `INSERT INTO runners (name, token, location_cycle_started_at) VALUES ($1, $2, NOW()) RETURNING id, name, created_at, location_cycle_started_at`,
    [name.slice(0, 80), token]
  );
  const runner = result.rows[0];
  await logEvent('RUNNER_JOINED', runner.id, `${runner.name} csatlakozott a játékhoz.`);
  res.json({ token, id: runner.id, name: runner.name });
}));

const hunterSessionSecret = () => process.env.HUNTER_SESSION_SECRET || process.env.SESSION_SECRET || process.env.HUNTER_PIN || 'change-me';
function signSession(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', hunterSessionSecret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verifySession(token) {
  try {
    const [body, sig] = String(token || '').split('.');
    if (!body || !sig) return false;
    const expected = crypto.createHmac('sha256', hunterSessionSecret()).update(body).digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return payload.role === 'hunter' && payload.exp > Date.now();
  } catch {
    return false;
  }
}

app.post('/api/auth/hunter', handleAsync(async (req, res) => {
  const pin = String(req.body.pin || '');
  if (!process.env.HUNTER_PIN || pin !== process.env.HUNTER_PIN) return res.status(401).json({ error: 'Helytelen PIN kód' });
  const token = signSession({ role: 'hunter', exp: Date.now() + 12 * 60 * 60 * 1000 });
  res.cookie('hunter_auth', token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 12 * 60 * 60 * 1000 });
  res.json({ success: true });
}));

const requireHunter = (req, res, next) => {
  if (!verifySession(req.cookies.hunter_auth)) return res.status(401).json({ error: 'Nem jogosult' });
  next();
};
const requireRunner = handleAsync(async (req, res, next) => {
  const token = String(req.headers.authorization || '').trim();
  if (!token) return res.status(401).json({ error: 'Hiányzó token' });
  const result = await db.query('SELECT * FROM runners WHERE token = $1', [token]);
  if (!result.rows[0]) return res.status(401).json({ error: 'Érvénytelen token' });
  req.runner = result.rows[0];
  next();
});

// STATE
const runnerSelect = `
  SELECT r.id, r.name, r.tracking_enabled, r.is_most_wanted,
         r.last_latitude, r.last_longitude, r.last_accuracy, r.last_speed, r.last_location_at,
         r.live_latitude, r.live_longitude, r.live_accuracy, r.live_speed, r.live_location_at,
         r.penalty_until, r.last_hunter_distance_km, r.last_hunter_speed, r.last_hunter_location_at,
         r.most_wanted_distance_km, r.most_wanted_speed, r.most_wanted_updated_at,
         r.created_at, r.location_cycle_started_at,
         (r.penalty_until IS NOT NULL AND r.penalty_until > NOW()) AS live_tracking_required,
         COALESCE(r.last_location_at, NOW()) + (s.location_interval * INTERVAL '1 minute') AS next_location_at
  FROM runners r CROSS JOIN settings s
`;

app.get('/api/state', requireHunter, handleAsync(async (req, res) => {
  await updateMostWantedMetrics();
  const [settings, runners, events, hunter] = await Promise.all([
    db.query('SELECT * FROM settings WHERE id = 1'),
    db.query(`${runnerSelect} ORDER BY r.id`),
    db.query('SELECT * FROM events ORDER BY created_at DESC LIMIT 50'),
    db.query('SELECT * FROM hunter_presence WHERE id = 1')
  ]);
  res.json({ settings: settings.rows[0], runners: runners.rows, events: events.rows, hunter: hunter.rows[0] || null });
}));

app.get('/api/runner/me', requireRunner, handleAsync(async (req, res) => {
  const result = await db.query(`
    SELECT r.id, r.name, r.tracking_enabled, r.is_most_wanted,
           r.last_latitude, r.last_longitude, r.last_accuracy, r.last_speed, r.last_location_at,
           r.live_latitude, r.live_longitude, r.live_accuracy, r.live_speed, r.live_location_at,
           r.penalty_until, r.last_hunter_distance_km, r.last_hunter_speed, r.last_hunter_location_at,
           r.most_wanted_distance_km, r.most_wanted_speed, r.most_wanted_updated_at,
           r.last_location_at, r.created_at, r.location_cycle_started_at,
           (r.penalty_until IS NOT NULL AND r.penalty_until > NOW()) AS live_tracking_required,
           COALESCE(r.last_location_at, NOW()) + (s.location_interval * INTERVAL '1 minute') AS next_location_at,
           s.id AS settings_id, s.location_interval, s.distance_enabled, s.updated_at,
           s.game_title, s.game_description, s.runner_instructions, s.announcement,
           s.live_update_interval, s.speed_enabled, s.alerts_enabled, s.high_accuracy_enabled,
           s.penalty_enabled, s.game_status, s.announcement_priority, s.accent_color
    FROM runners r CROSS JOIN settings s WHERE r.id = $1 AND s.id = 1
  `, [req.runner.id]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Játékos nem található' });
  const row = result.rows[0];
  const settings = {
    id: row.settings_id, location_interval: row.location_interval, distance_enabled: row.distance_enabled,
    updated_at: row.updated_at, game_title: row.game_title, game_description: row.game_description,
    runner_instructions: row.runner_instructions, announcement: row.announcement,
    live_update_interval: row.live_update_interval, speed_enabled: row.speed_enabled,
    alerts_enabled: row.alerts_enabled, high_accuracy_enabled: row.high_accuracy_enabled,
    penalty_enabled: row.penalty_enabled, game_status: row.game_status,
    announcement_priority: row.announcement_priority, accent_color: row.accent_color
  };
  for (const key of ['settings_id','location_interval','distance_enabled','updated_at','game_title','game_description','runner_instructions','announcement','live_update_interval','speed_enabled','alerts_enabled','high_accuracy_enabled','penalty_enabled','game_status','announcement_priority','accent_color']) delete row[key];
  res.json({ runner: row, settings });
}));

app.get('/api/runner/updates', requireRunner, handleAsync(async (req, res) => {
  const [settings, messages, runner, hunter] = await Promise.all([
    db.query('SELECT * FROM settings WHERE id = 1'),
    db.query('SELECT id, runner_id, message, priority, created_at FROM messages WHERE runner_id IS NULL OR runner_id = $1 ORDER BY created_at DESC LIMIT 30', [req.runner.id]),
    db.query(`${runnerSelect} WHERE r.id = $1`, [req.runner.id]),
    db.query('SELECT id, latitude, longitude, accuracy, speed, location_at, updated_at FROM hunter_presence WHERE id = 1')
  ]);
  const currentRunner = runner.rows[0];
  const currentHunter = hunter.rows[0] || null;
  res.json({
    settings: settings.rows[0], messages: messages.rows, runner: currentRunner,
    hunter: currentHunter ? { ...currentHunter, distance_km: null } : null
  });
}));

// Hivatalos helyzetküldés
app.post('/api/location', requireRunner, handleAsync(async (req, res) => {
  const latitude = Number(req.body.latitude);
  const longitude = Number(req.body.longitude);
  const accuracy = finiteNumber(req.body.accuracy);
  const speed = finiteNumber(req.body.speed);
  if (!validCoordinate(latitude, -90, 90) || !validCoordinate(longitude, -180, 180)) return res.status(400).json({ error: 'Érvénytelen helyadat' });

  const schedule = await db.query(`
    SELECT r.last_location_at, r.location_cycle_started_at, r.created_at, s.location_interval
    FROM runners r CROSS JOIN settings s WHERE r.id = $1 AND s.id = 1
  `, [req.runner.id]);
  const row = schedule.rows[0];
  if (!row) return res.status(404).json({ error: 'Játékos nem található' });
  if (row.last_location_at) {
    const nextAllowed = new Date(new Date(row.last_location_at).getTime() + Number(row.location_interval) * 60000);
    if (Date.now() < nextAllowed.getTime()) return res.status(429).json({ error: 'A helyzetküldés még nem esedékes.', next_location_at: nextAllowed.toISOString() });
  }

  const hunter = (await db.query('SELECT latitude, longitude, speed, location_at FROM hunter_presence WHERE id = 1')).rows[0] || null;
  const hunterDistance = hunter ? distanceInKm(latitude, longitude, hunter.latitude, hunter.longitude) : null;
  const now = new Date();

  await db.query(`
    UPDATE runners
    SET last_latitude = $1, last_longitude = $2, last_accuracy = $3, last_speed = $4,
        last_location_at = $5, location_cycle_started_at = $5,
        live_latitude = $1, live_longitude = $2, live_accuracy = $3, live_speed = $4, live_location_at = $5,
        last_hunter_distance_km = $6, last_hunter_speed = $7, last_hunter_location_at = $8
    WHERE id = $9
  `, [latitude, longitude, accuracy, speed, now, hunterDistance, hunter ? finiteNumber(hunter.speed) : null, hunter?.location_at || null, req.runner.id]);

  await db.query('INSERT INTO locations (runner_id, latitude, longitude, accuracy, speed) VALUES ($1, $2, $3, $4, $5)', [req.runner.id, latitude, longitude, accuracy, speed]);
  await logEvent('LOCATION_UPDATE', req.runner.id, `${req.runner.name} új hivatalos helyzetet küldött.`);

  await updateMostWantedMetrics();

  res.json({
    success: true,
    last_location_at: now.toISOString(),
    next_location_at: new Date(now.getTime() + Number(row.location_interval) * 60000).toISOString(),
    hunter: hunter ? { ...hunter, distance_km: hunterDistance } : null
  });
}));

// Élő helyzet (büntetés alatt)
app.post('/api/runner/live-location', requireRunner, handleAsync(async (req, res) => {
  const latitude = Number(req.body.latitude);
  const longitude = Number(req.body.longitude);
  const accuracy = finiteNumber(req.body.accuracy);
  const speed = finiteNumber(req.body.speed);
  if (!validCoordinate(latitude, -90, 90) || !validCoordinate(longitude, -180, 180)) return res.status(400).json({ error: 'Érvénytelen élő helyadat' });
  const fresh = (await db.query('SELECT penalty_until FROM runners WHERE id = $1', [req.runner.id])).rows[0];
  if (!liveTrackingActive(fresh)) return res.status(409).json({ error: 'Nincs aktív folyamatos láthatósági büntetés.' });
  await db.query(`UPDATE runners SET live_latitude = $1, live_longitude = $2, live_accuracy = $3, live_speed = $4, live_location_at = NOW() WHERE id = $5`, [latitude, longitude, accuracy, speed, req.runner.id]);
  
  await updateMostWantedMetrics();
  
  res.json({ success: true, live: true });
}));

// HUNTER SETTINGS
app.post('/api/settings', requireHunter, handleAsync(async (req, res) => {
  const current = await getSettings();
  const nInt = Number(req.body.location_interval);
  const nLive = Number(req.body.live_update_interval);
  const interval = Number.isInteger(nInt) && nInt > 0 ? nInt : current.location_interval;
  const liveInterval = Number.isInteger(nLive) && nLive >= 1 && nLive <= 10 ? nLive : current.live_update_interval;
  const text = (value, fallback, max) => typeof value === 'string' ? value.trim().slice(0, max) : fallback;
  const next = {
    game_title: text(req.body.game_title, current.game_title, 120),
    game_description: text(req.body.game_description, current.game_description, 500),
    runner_instructions: text(req.body.runner_instructions, current.runner_instructions, 1000),
    announcement: text(req.body.announcement, current.announcement, 500),
    distance_enabled: typeof req.body.distance_enabled === 'boolean' ? req.body.distance_enabled : current.distance_enabled,
    speed_enabled: typeof req.body.speed_enabled === 'boolean' ? req.body.speed_enabled : current.speed_enabled,
    alerts_enabled: typeof req.body.alerts_enabled === 'boolean' ? req.body.alerts_enabled : current.alerts_enabled,
    high_accuracy_enabled: typeof req.body.high_accuracy_enabled === 'boolean' ? req.body.high_accuracy_enabled : current.high_accuracy_enabled,
    penalty_enabled: typeof req.body.penalty_enabled === 'boolean' ? req.body.penalty_enabled : current.penalty_enabled,
    game_status: ['waiting','live','paused','finished'].includes(req.body.game_status) ? req.body.game_status : current.game_status,
    announcement_priority: getPriority(req.body.announcement_priority || current.announcement_priority),
    accent_color: typeof req.body.accent_color === 'string' && /^#[0-9a-f]{6}$/i.test(req.body.accent_color) ? req.body.accent_color : current.accent_color
  };
  await db.query(`UPDATE settings SET location_interval=$1, live_update_interval=$2, game_title=$3, game_description=$4, runner_instructions=$5, announcement=$6, distance_enabled=$7, speed_enabled=$8, alerts_enabled=$9, high_accuracy_enabled=$10, penalty_enabled=$11, game_status=$12, announcement_priority=$13, accent_color=$14, updated_at=NOW() WHERE id=1`, [interval, liveInterval, next.game_title, next.game_description, next.runner_instructions, next.announcement, next.distance_enabled, next.speed_enabled, next.alerts_enabled, next.high_accuracy_enabled, next.penalty_enabled, next.game_status, next.announcement_priority, next.accent_color]);
  if (interval !== Number(current.location_interval)) await db.query('UPDATE runners SET location_cycle_started_at = NOW()');
  res.json({ success: true, settings: await getSettings() });
}));

app.post('/api/hunter/reset', requireHunter, handleAsync(async (req, res) => {
  await db.query('TRUNCATE locations, messages, events, runners RESTART IDENTITY CASCADE');
  await db.query(`UPDATE settings SET location_interval=20, live_update_interval=1, distance_enabled=TRUE, speed_enabled=TRUE, alerts_enabled=TRUE, high_accuracy_enabled=TRUE, penalty_enabled=TRUE, game_status='waiting', announcement_priority='important', accent_color='#9b87f5', game_title='Most Wanted - A hajsza', game_description='A vadászok követik a menekülőket.', runner_instructions='Tartsd nyitva az oldalt és engedélyezd a helymeghatározást.', announcement='A játékhoz tartozó üzenetek itt jelennek meg.', updated_at=NOW() WHERE id=1`);
  await db.query('UPDATE hunter_presence SET latitude=NULL, longitude=NULL, accuracy=NULL, speed=NULL, location_at=NULL, updated_at=NOW() WHERE id=1');
  hunterPrevious = null;
  res.json({ success: true });
}));

app.post('/api/hunter/most-wanted', requireHunter, handleAsync(async (req, res) => {
  const runnerId = req.body.runner_id ? Number(req.body.runner_id) : null;
  await db.query('UPDATE runners SET is_most_wanted = FALSE, most_wanted_distance_km = NULL, most_wanted_speed = NULL, most_wanted_updated_at = NULL');
  if (runnerId) {
    const runner = (await db.query('SELECT id, name FROM runners WHERE id=$1', [runnerId])).rows[0];
    if (!runner) return res.status(404).json({ error: 'A játékos nem található' });
    await db.query('UPDATE runners SET is_most_wanted=TRUE WHERE id=$1', [runnerId]);
    await logEvent('MOST_WANTED_SET', runnerId, `${runner.name} lett a Most Wanted.`);
    await updateMostWantedMetrics();
  } else {
    await logEvent('MOST_WANTED_CLEARED', null, 'Most Wanted státusz törölve.');
  }
  res.json({ success: true });
}));

app.post('/api/hunter/penalty', requireHunter, handleAsync(async (req, res) => {
  const runnerId = Number(req.body.runner_id);
  const minutes = Number(req.body.minutes);
  if (!Number.isInteger(runnerId) || !Number.isInteger(minutes) || minutes < 0 || minutes > 10) return res.status(400).json({ error: 'A büntetés 0 és 10 perc közötti egész szám lehet.' });
  const runner = (await db.query('SELECT id, name FROM runners WHERE id=$1', [runnerId])).rows[0];
  if (!runner) return res.status(404).json({ error: 'A játékos nem található' });
  const until = minutes > 0 ? new Date(Date.now() + minutes * 60000) : null;
  await db.query('UPDATE runners SET penalty_until=$1 WHERE id=$2', [runnerId]);
  const text = minutes > 0 ? `Büntetést kaptál: ${minutes} percig folyamatosan látható a helyzeted a vadász számára.` : 'A folyamatos láthatósági büntetésed megszűnt.';
  await db.query('INSERT INTO messages (runner_id, message, priority) VALUES ($1,$2,$3)', [runnerId, text, minutes > 0 ? 'urgent' : 'important']);
  await logEvent(minutes > 0 ? 'PENALTY_SET' : 'PENALTY_CLEARED', runnerId, minutes > 0 ? `${runner.name} ${minutes} perces folyamatos láthatóságot kapott.` : `${runner.name} büntetése törölve.`);
  res.json({ success: true, penalty_until: until ? until.toISOString() : null });
}));

app.post('/api/hunter/location', requireHunter, handleAsync(async (req, res) => {
  const latitude = Number(req.body.latitude);
  const longitude = Number(req.body.longitude);
  const accuracy = finiteNumber(req.body.accuracy);
  const now = new Date();
  if (!validCoordinate(latitude, -90, 90) || !validCoordinate(longitude, -180, 180)) return res.status(400).json({ error: 'Érvénytelen vadász helyadat' });
  const serverSpeed = currentHunterSpeedMetersPerSecond(latitude, longitude, now, req.body.speed);
  await db.query('UPDATE hunter_presence SET latitude=$1, longitude=$2, accuracy=$3, speed=$4, location_at=$5, updated_at=NOW() WHERE id=1', [latitude, longitude, accuracy, serverSpeed, now]);
  hunterPrevious = { lat: latitude, lng: longitude, at: now };

  await updateMostWantedMetrics();

  res.json({ success: true, speed: serverSpeed });
}));

app.post('/api/hunter/message', requireHunter, handleAsync(async (req, res) => {
  const message = String(req.body.message || '').trim();
  if (!message) return res.status(400).json({ error: 'Az üzenet nem lehet üres' });
  const runnerId = req.body.runner_id ? Number(req.body.runner_id) : null;
  const priority = getPriority(req.body.priority);
  await db.query('INSERT INTO messages (runner_id, message, priority) VALUES ($1,$2,$3)', [runnerId, message.slice(0, 500), priority]);
  await logEvent('MESSAGE_SENT', runnerId, `[${priority.toUpperCase()}] Üzenet: ${message}`);
  res.json({ success: true });
}));

app.post('/api/runner/leave', requireRunner, handleAsync(async (req, res) => {
  await db.query('DELETE FROM runners WHERE id=$1', [req.runner.id]);
  res.json({ success: true });
}));

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.use((err, req, res, next) => {
  console.error('API ERROR', req.method, req.originalUrl, err?.stack || err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Szerverhiba', message: process.env.NODE_ENV === 'production' ? undefined : String(err?.message || err) });
});

const PORT = Number(process.env.PORT || 3000);
(async () => {
  await ensureSchema();
  server.listen(PORT, '0.0.0.0', () => console.log(`Szerver fut a ${PORT} porton`));
})().catch((error) => {
  console.error('INDULÁSI HIBA', error?.stack || error);
  process.exit(1);
});