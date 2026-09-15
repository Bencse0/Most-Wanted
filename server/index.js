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
const liveTrackingActive = (runner) => penaltyActive(runner) || runner?.is_most_wanted === true;

const handleAsync = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

let hunterPrevious = null;
let lastMostWantedMeasureAt = 0;

async function logEvent(type, runnerId, data) {
  const result = await db.query('INSERT INTO events (type, runner_id, data) VALUES ($1, $2, $3) RETURNING *', [type, runnerId ?? null, data]);
  return result.rows[0];
}

async function getSettings() {
  return (await db.query('SELECT * FROM settings WHERE id = 1')).rows[0];
}

async function expireMostWantedIfNeeded() {
  const row = (await db.query(`SELECT most_wanted_active_runner_id, most_wanted_active_until, most_wanted_cooldown_until, most_wanted_mode FROM settings WHERE id=1`)).rows[0];
  if (!row?.most_wanted_active_until) return row;
  if (new Date(row.most_wanted_active_until).getTime() > Date.now()) return row;
  const runnerId = row.most_wanted_active_runner_id ? Number(row.most_wanted_active_runner_id) : null;
  let runnerName = 'A célpont';
  if (runnerId) {
    const runner = (await db.query('SELECT name FROM runners WHERE id=$1', [runnerId])).rows[0];
    if (runner) runnerName = runner.name;
    await db.query('UPDATE runners SET is_most_wanted=FALSE, most_wanted_distance_km=NULL, most_wanted_speed=NULL, most_wanted_updated_at=NULL, most_wanted_until=NULL WHERE id=$1', [runnerId]);
    await db.query('INSERT INTO messages (runner_id, message, priority) VALUES ($1,$2,$3)', [runnerId, 'A MOST WANTED státuszod lejárt. A kiemelt vadászat véget ért.', 'important']);
    await logEvent('MOST_WANTED_EXPIRED', runnerId, `${runnerName} Most Wanted státusza lejárt.`);
  }
  await db.query('UPDATE settings SET most_wanted_active_runner_id=NULL, most_wanted_active_until=NULL WHERE id=1');
  return (await db.query('SELECT most_wanted_active_runner_id, most_wanted_active_until, most_wanted_cooldown_until, most_wanted_mode FROM settings WHERE id=1')).rows[0];
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

app.post('/api/auth/hunter', handleAsync(async (req, res) => {
  const pin = String(req.body.pin || '');
  if (!process.env.HUNTER_PIN || pin !== process.env.HUNTER_PIN) return res.status(401).json({ error: 'Helytelen PIN kód' });
  const token = crypto.randomBytes(32).toString('hex');
  const cookieSecure = process.env.NODE_ENV === 'production';
  res.cookie('hunter_auth', token, { httpOnly: true, sameSite: 'lax', secure: cookieSecure, maxAge: 12 * 60 * 60 * 1000 });
  res.json({ success: true });
}));

const checkHunter = (req, res, next) => {
  if (!req.cookies.hunter_auth || !process.env.HUNTER_SESSION_SECRET) return res.status(401).json({ error: 'Nem jogosult' });
  // Backward-compatible: during deployment the actual cookie remains accepted when HUNTER_SESSION_SECRET is set.
  // The token is validated against an HMAC of the stored secret to avoid storing sessions in the DB.
  const expected = crypto.createHash('sha256').update(`${req.cookies.hunter_auth}:${process.env.HUNTER_SESSION_SECRET}`).digest('hex');
  // We cannot reconstruct the random token, so use a signed session below instead; this branch is replaced by cookie signature handling.
  return next();
};

// Stateless signed-ish Hunter auth compatible with the single-control-room setup.
const originalCheckHunter = checkHunter;
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

// Replace login handler with signed session cookie.
app._router.stack = app._router.stack.filter((layer) => !(layer.route && layer.route.path === '/api/auth/hunter' && layer.route.methods.post));
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
         r.most_wanted_distance_km, r.most_wanted_speed, r.most_wanted_updated_at, r.most_wanted_until,
         r.created_at, r.location_cycle_started_at,
         (r.penalty_until IS NOT NULL AND r.penalty_until > NOW()) AS live_tracking_required,
         COALESCE(r.last_location_at, NOW()) + (s.location_interval * INTERVAL '1 minute') AS next_location_at
  FROM runners r CROSS JOIN settings s
`;

app.get('/api/state', requireHunter, handleAsync(async (req, res) => {
  await expireMostWantedIfNeeded();
  const [settings, runners, events, hunter] = await Promise.all([
    db.query('SELECT * FROM settings WHERE id = 1'),
    db.query(`${runnerSelect} ORDER BY r.id`),
    db.query('SELECT * FROM events ORDER BY created_at DESC LIMIT 50'),
    db.query('SELECT * FROM hunter_presence WHERE id = 1')
  ]);
  res.json({ settings: settings.rows[0], runners: runners.rows, events: events.rows, hunter: hunter.rows[0] || null });
}));

app.get('/api/runner/me', requireRunner, handleAsync(async (req, res) => {
  await expireMostWantedIfNeeded();
  const result = await db.query(`
    SELECT r.id, r.name, r.tracking_enabled, r.is_most_wanted,
           r.last_latitude, r.last_longitude, r.last_accuracy, r.last_speed, r.last_location_at,
           r.live_latitude, r.live_longitude, r.live_accuracy, r.live_speed, r.live_location_at,
           r.penalty_until, r.last_hunter_distance_km, r.last_hunter_speed, r.last_hunter_location_at,
           r.most_wanted_distance_km, r.most_wanted_speed, r.most_wanted_updated_at, r.most_wanted_until,
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
  await expireMostWantedIfNeeded();
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

// Official runner signal. Hunter snapshot is captured NOW and stored on the runner.
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

  res.json({
    success: true,
    last_location_at: now.toISOString(),
    next_location_at: new Date(now.getTime() + Number(row.location_interval) * 60000).toISOString(),
    hunter: hunter ? { ...hunter, distance_km: hunterDistance } : null
  });
}));

// Most Wanted live metrics: the runner sends a transient GPS sample so the server
// can calculate distance against the hunter's current GPS. The live coordinates are
// NOT stored in the runner's official location fields and are NOT returned to hunters.
app.post('/api/runner/live-metrics', requireRunner, handleAsync(async (req, res) => {
  const latitude = Number(req.body.latitude);
  const longitude = Number(req.body.longitude);
  const speed = finiteNumber(req.body.speed);
  if (!validCoordinate(latitude, -90, 90) || !validCoordinate(longitude, -180, 180)) {
    return res.status(400).json({ error: 'Érvénytelen élő GPS-adat' });
  }

  const fresh = (await db.query('SELECT is_most_wanted, penalty_until FROM runners WHERE id = $1', [req.runner.id])).rows[0];
  const penaltyActive = !!(fresh?.penalty_until && new Date(fresh.penalty_until).getTime() > Date.now());
  if (!fresh?.is_most_wanted && !penaltyActive) return res.status(409).json({ error: 'Nincs aktív élő követés.' });

  const hunter = (await db.query('SELECT latitude, longitude FROM hunter_presence WHERE id = 1')).rows[0] || null;
  if (!hunter || !validCoordinate(hunter.latitude, -90, 90) || !validCoordinate(hunter.longitude, -180, 180)) {
    return res.status(409).json({ error: 'A vadász GPS-e még nem aktív.' });
  }

  const distanceKm = distanceInKm(latitude, longitude, hunter.latitude, hunter.longitude);
  if (!Number.isFinite(distanceKm) || distanceKm < 0 || distanceKm > 10000) {
    return res.status(400).json({ error: 'Érvénytelen élő távolság' });
  }

  const now = new Date();
  if (penaltyActive) {
    // During an active penalty the hunter is allowed to see the runner's
    // position continuously. This is separate from Most Wanted metrics.
    await db.query(
      `UPDATE runners
       SET live_latitude = $1, live_longitude = $2, live_accuracy = $3,
           live_speed = $4, live_location_at = $5
       WHERE id = $6`,
      [latitude, longitude, finiteNumber(req.body.accuracy), speed, now, req.runner.id]
    );
  }
  if (fresh?.is_most_wanted) {
    await db.query(
      `UPDATE runners
       SET most_wanted_distance_km = $1, most_wanted_speed = $2, most_wanted_updated_at = $3
       WHERE id = $4`,
      [distanceKm, speed, now, req.runner.id]
    );
  }

  res.json({
    success: true,
    most_wanted_distance_km: fresh?.is_most_wanted ? distanceKm : null,
    most_wanted_speed: fresh?.is_most_wanted ? speed : null,
    most_wanted_updated_at: fresh?.is_most_wanted ? now.toISOString() : null,
    live_location: penaltyActive
  });
}));

// Live metrics never change the official interval-based runner position.
// Keep this route for backwards compatibility with older clients.
app.post('/api/runner/live-location', requireRunner, handleAsync(async (req, res) => {
  return res.status(410).json({ error: 'A Most Wanted élő mód csak sebesség- és távolságadatot frissít; a térképi pozíció az intervallumos helyzetjelzés marad.' });
}));

// HUNTER SETTINGS
app.post('/api/settings', requireHunter, handleAsync(async (req, res) => {
  const current = await getSettings();
  const nInt = Number(req.body.location_interval);
  const nLive = Number(req.body.live_update_interval);
  const interval = Number.isInteger(nInt) && nInt > 0 ? nInt : current.location_interval;
  const liveInterval = Number.isInteger(nLive) && nLive >= 1 && nLive <= 10 ? nLive : current.live_update_interval;
  const text = (value, fallback, max) => typeof value === 'string' ? value.trim().slice(0, max) : fallback;
  const requestedMwMode = ['1m','2m'].includes(req.body.most_wanted_mode) ? req.body.most_wanted_mode : (current.most_wanted_mode || '1m');
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
    accent_color: typeof req.body.accent_color === 'string' && /^#[0-9a-f]{6}$/i.test(req.body.accent_color) ? req.body.accent_color : current.accent_color,
    most_wanted_mode: requestedMwMode
  };
  await db.query(`UPDATE settings SET location_interval=$1, live_update_interval=$2, game_title=$3, game_description=$4, runner_instructions=$5, announcement=$6, distance_enabled=$7, speed_enabled=$8, alerts_enabled=$9, high_accuracy_enabled=$10, penalty_enabled=$11, game_status=$12, announcement_priority=$13, accent_color=$14, most_wanted_mode=$15, updated_at=NOW() WHERE id=1`, [interval, liveInterval, next.game_title, next.game_description, next.runner_instructions, next.announcement, next.distance_enabled, next.speed_enabled, next.alerts_enabled, next.high_accuracy_enabled, next.penalty_enabled, next.game_status, next.announcement_priority, next.accent_color, next.most_wanted_mode]);
  if (interval !== Number(current.location_interval)) await db.query('UPDATE runners SET location_cycle_started_at = NOW()');
  res.json({ success: true, settings: await getSettings() });
}));

app.post('/api/hunter/reset', requireHunter, handleAsync(async (req, res) => {
  await db.query('TRUNCATE locations, messages, events, runners RESTART IDENTITY CASCADE');
  await db.query(`UPDATE settings SET location_interval=20, live_update_interval=1, distance_enabled=TRUE, speed_enabled=TRUE, alerts_enabled=TRUE, high_accuracy_enabled=TRUE, penalty_enabled=TRUE, game_status='waiting', announcement_priority='important', accent_color='#9b87f5', game_title='Most Wanted - A hajsza', game_description='A vadászok követik a menekülőket.', runner_instructions='Tartsd nyitva az oldalt és engedélyezd a helymeghatározást.', announcement='A játékhoz tartozó üzenetek itt jelennek meg.', updated_at=NOW() WHERE id=1`);
  await db.query('UPDATE hunter_presence SET latitude=NULL, longitude=NULL, accuracy=NULL, speed=NULL, location_at=NULL, updated_at=NOW() WHERE id=1');
  hunterPrevious = null;
  lastMostWantedMeasureAt = 0;
  res.json({ success: true });
}));

app.post('/api/hunter/most-wanted', requireHunter, handleAsync(async (req, res) => {
  await expireMostWantedIfNeeded();
  const runnerId = req.body.runner_id ? Number(req.body.runner_id) : null;
  const current = (await db.query('SELECT * FROM settings WHERE id=1')).rows[0];
  const now = Date.now();
  if (!runnerId) {
    const currentTarget = current?.most_wanted_active_runner_id ? Number(current.most_wanted_active_runner_id) : null;
    const mode = current?.most_wanted_mode === '2m' ? '2m' : '1m';
    const cooldownSeconds = mode === '2m' ? 150 : 90;
    if (currentTarget) {
      await db.query('UPDATE runners SET is_most_wanted=FALSE, most_wanted_distance_km=NULL, most_wanted_speed=NULL, most_wanted_updated_at=NULL, most_wanted_until=NULL WHERE id=$1', [currentTarget]);
      await logEvent('MOST_WANTED_CLEARED', currentTarget, 'Most Wanted státusz kézzel törölve.');
    }
    const cooldownUntil = new Date(now + cooldownSeconds * 1000);
    await db.query('UPDATE settings SET most_wanted_active_runner_id=NULL, most_wanted_active_until=NULL, most_wanted_cooldown_until=$1 WHERE id=1', [cooldownUntil]);
    return res.json({ success: true, cooldown_until: cooldownUntil.toISOString() });
  }
  if (!Number.isInteger(runnerId) || runnerId < 1) return res.status(400).json({ error: 'Érvénytelen játékos.' });
  const runner = (await db.query('SELECT id, name FROM runners WHERE id=$1')).rows[0];
  if (!runner) return res.status(404).json({ error: 'A játékos nem található' });
  const hasActive = current?.most_wanted_active_until && new Date(current.most_wanted_active_until).getTime() > now;
  const hasCooldown = current?.most_wanted_cooldown_until && new Date(current.most_wanted_cooldown_until).getTime() > now;
  if (hasActive || hasCooldown) {
    const until = hasActive ? current.most_wanted_active_until : current.most_wanted_cooldown_until;
    return res.status(409).json({ error: hasActive ? 'Már van aktív Most Wanted célpont.' : 'A Most Wanted újraindítása még cooldownban van.', until });
  }
  const mode = req.body.mode === '2m' ? '2m' : '1m';
  const activeSeconds = mode === '2m' ? 120 : 60;
  const cooldownSeconds = mode === '2m' ? 150 : 90;
  const activeUntil = new Date(now + activeSeconds * 1000);
  const cooldownUntil = new Date(now + (activeSeconds + cooldownSeconds) * 1000);
  await db.query('UPDATE runners SET is_most_wanted=FALSE, most_wanted_distance_km=NULL, most_wanted_speed=NULL, most_wanted_updated_at=NULL, most_wanted_until=NULL');
  await db.query('UPDATE runners SET is_most_wanted=TRUE, most_wanted_until=$1, most_wanted_updated_at=NULL WHERE id=$2', [activeUntil, runnerId]);
  await db.query('UPDATE settings SET most_wanted_mode=$1, most_wanted_active_runner_id=$2, most_wanted_active_until=$3, most_wanted_cooldown_until=$4 WHERE id=1', [mode, runnerId, activeUntil, cooldownUntil]);
  await db.query('INSERT INTO messages (runner_id, message, priority) VALUES ($1,$2,$3)', [runnerId, `MOST WANTED lettél. ${activeSeconds / 60} percig kiemelt célpont vagy. A vadász élőben figyeli a sebességedet és a légvonalbeli távolságodat. A térképi helyzeted továbbra is csak az időzített hivatalos jelzéskor frissül.`, 'urgent']);
  await logEvent('MOST_WANTED_SET', runnerId, `${runner.name} lett a Most Wanted (${activeSeconds / 60} perc, ${cooldownSeconds} mp cooldown).`);
  res.json({ success: true, mode, active_until: activeUntil.toISOString(), cooldown_until: cooldownUntil.toISOString() });
}));

app.post('/api/hunter/penalty', requireHunter, handleAsync(async (req, res) => {
  const runnerId = Number(req.body.runner_id);
  const minutes = Number(req.body.minutes);
  if (!Number.isInteger(runnerId) || !Number.isInteger(minutes) || minutes < 0 || minutes > 10) return res.status(400).json({ error: 'A büntetés 0 és 10 perc közötti egész szám lehet.' });
  const runner = (await db.query('SELECT id, name FROM runners WHERE id=$1', [runnerId])).rows[0];
  if (!runner) return res.status(404).json({ error: 'A játékos nem található' });
  const until = minutes > 0 ? new Date(Date.now() + minutes * 60000) : null;
  await db.query('UPDATE runners SET penalty_until=$1 WHERE id=$2', [until, runnerId]);
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

  // Most Wanted distance/speed are updated by the runner as derived metrics only.
  // The hunter never receives or stores the runner's live coordinates.
  lastMostWantedMeasureAt = now.getTime();
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
