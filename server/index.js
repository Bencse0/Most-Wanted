require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const db = require('./db');

const app = express();
const server = http.createServer(app);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public')));

const logEvent = async (type, runnerId, data) => {
  const result = await db.query(
    'INSERT INTO events (type, runner_id, data) VALUES ($1, $2, $3) RETURNING *',
    [type, runnerId ?? null, data]
  );
  return result.rows[0];
};

const handleAsync = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

const finiteNumber = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
const distanceInKm = (lat1, lon1, lat2, lon2) => {
  if ([lat1, lon1, lat2, lon2].some((value) => value === null || !Number.isFinite(Number(value)))) {
    return null;
  }
  const toRadians = (value) => Number(value) * Math.PI / 180;
  const earthRadius = 6371;
  const dLat = toRadians(Number(lat2) - Number(lat1));
  const dLon = toRadians(Number(lon2) - Number(lon1));
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
  return earthRadius * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
};

const getPriority = (value) => ['normal', 'important', 'urgent'].includes(value) ? value : 'normal';

async function ensureDatabaseSchema() {
  const statements = [
    `CREATE TABLE IF NOT EXISTS runners (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      token TEXT UNIQUE NOT NULL,
      tracking_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      is_most_wanted BOOLEAN NOT NULL DEFAULT FALSE,
      last_latitude DOUBLE PRECISION,
      last_longitude DOUBLE PRECISION,
      last_accuracy DOUBLE PRECISION,
      last_location_at TIMESTAMPTZ,
      last_speed DOUBLE PRECISION,
      live_latitude DOUBLE PRECISION,
      live_longitude DOUBLE PRECISION,
      live_accuracy DOUBLE PRECISION,
      live_speed DOUBLE PRECISION,
      live_location_at TIMESTAMPTZ,
      penalty_until TIMESTAMPTZ,
      last_hunter_distance_km DOUBLE PRECISION,
      last_hunter_speed DOUBLE PRECISION,
      last_hunter_location_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      location_cycle_started_at TIMESTAMPTZ
    )`,
    `CREATE TABLE IF NOT EXISTS locations (
      id BIGSERIAL PRIMARY KEY,
      runner_id BIGINT REFERENCES runners(id) ON DELETE CASCADE,
      latitude DOUBLE PRECISION NOT NULL,
      longitude DOUBLE PRECISION NOT NULL,
      accuracy DOUBLE PRECISION,
      speed DOUBLE PRECISION,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY,
      location_interval INTEGER NOT NULL DEFAULT 20,
      distance_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      game_title TEXT NOT NULL DEFAULT 'Most Wanted - A hajsza',
      game_description TEXT NOT NULL DEFAULT '',
      runner_instructions TEXT NOT NULL DEFAULT '',
      announcement TEXT NOT NULL DEFAULT '',
      live_update_interval INTEGER NOT NULL DEFAULT 1,
      speed_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      alerts_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      high_accuracy_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      penalty_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      game_status TEXT NOT NULL DEFAULT 'waiting',
      announcement_priority TEXT NOT NULL DEFAULT 'important',
      accent_color TEXT NOT NULL DEFAULT '#9b87f5'
    )`,
    `CREATE TABLE IF NOT EXISTS messages (
      id BIGSERIAL PRIMARY KEY,
      runner_id BIGINT REFERENCES runners(id) ON DELETE CASCADE,
      message TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS events (
      id BIGSERIAL PRIMARY KEY,
      type TEXT,
      runner_id BIGINT REFERENCES runners(id) ON DELETE SET NULL,
      data TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS hunter_presence (
      id INTEGER PRIMARY KEY,
      latitude DOUBLE PRECISION,
      longitude DOUBLE PRECISION,
      accuracy DOUBLE PRECISION,
      speed DOUBLE PRECISION,
      location_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `ALTER TABLE runners ADD COLUMN IF NOT EXISTS tracking_enabled BOOLEAN NOT NULL DEFAULT TRUE`,
    `ALTER TABLE runners ADD COLUMN IF NOT EXISTS is_most_wanted BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE runners ADD COLUMN IF NOT EXISTS last_speed DOUBLE PRECISION`,
    `ALTER TABLE runners ADD COLUMN IF NOT EXISTS live_latitude DOUBLE PRECISION`,
    `ALTER TABLE runners ADD COLUMN IF NOT EXISTS live_longitude DOUBLE PRECISION`,
    `ALTER TABLE runners ADD COLUMN IF NOT EXISTS live_accuracy DOUBLE PRECISION`,
    `ALTER TABLE runners ADD COLUMN IF NOT EXISTS live_speed DOUBLE PRECISION`,
    `ALTER TABLE runners ADD COLUMN IF NOT EXISTS live_location_at TIMESTAMPTZ`,
    `ALTER TABLE runners ADD COLUMN IF NOT EXISTS penalty_until TIMESTAMPTZ`,
    `ALTER TABLE runners ADD COLUMN IF NOT EXISTS last_hunter_distance_km DOUBLE PRECISION`,
    `ALTER TABLE runners ADD COLUMN IF NOT EXISTS last_hunter_speed DOUBLE PRECISION`,
    `ALTER TABLE runners ADD COLUMN IF NOT EXISTS last_hunter_location_at TIMESTAMPTZ`,
    `ALTER TABLE runners ADD COLUMN IF NOT EXISTS location_cycle_started_at TIMESTAMPTZ`,
    `ALTER TABLE locations ADD COLUMN IF NOT EXISTS speed DOUBLE PRECISION`,
    `ALTER TABLE messages ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'normal'`,
    `ALTER TABLE settings ADD COLUMN IF NOT EXISTS game_title TEXT NOT NULL DEFAULT 'Most Wanted - A hajsza'`,
    `ALTER TABLE settings ADD COLUMN IF NOT EXISTS game_description TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE settings ADD COLUMN IF NOT EXISTS runner_instructions TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE settings ADD COLUMN IF NOT EXISTS announcement TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE settings ADD COLUMN IF NOT EXISTS live_update_interval INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE settings ADD COLUMN IF NOT EXISTS speed_enabled BOOLEAN NOT NULL DEFAULT TRUE`,
    `ALTER TABLE settings ADD COLUMN IF NOT EXISTS alerts_enabled BOOLEAN NOT NULL DEFAULT TRUE`,
    `ALTER TABLE settings ADD COLUMN IF NOT EXISTS high_accuracy_enabled BOOLEAN NOT NULL DEFAULT TRUE`,
    `ALTER TABLE settings ADD COLUMN IF NOT EXISTS penalty_enabled BOOLEAN NOT NULL DEFAULT TRUE`,
    `ALTER TABLE settings ADD COLUMN IF NOT EXISTS game_status TEXT NOT NULL DEFAULT 'waiting'`,
    `ALTER TABLE settings ADD COLUMN IF NOT EXISTS announcement_priority TEXT NOT NULL DEFAULT 'important'`,
    `ALTER TABLE settings ADD COLUMN IF NOT EXISTS accent_color TEXT NOT NULL DEFAULT '#9b87f5'`,
    `INSERT INTO settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`,
    `INSERT INTO hunter_presence (id) VALUES (1) ON CONFLICT (id) DO NOTHING`
  ];
  for (const statement of statements) await db.query(statement);
}

// --- AUTH API ---
app.post('/api/auth/runner', handleAsync(async (req, res) => {
  const { gameCode, name } = req.body;
  if (gameCode !== process.env.GAME_CODE) {
    return res.status(401).json({ error: 'Érvénytelen játékkód' });
  }
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Név megadása kötelező' });
  }

  const token = crypto.randomBytes(16).toString('hex');
  const result = await db.query(
    `INSERT INTO runners (name, token, location_cycle_started_at)
     VALUES ($1, $2, NOW())
     RETURNING id, name, created_at, location_cycle_started_at`,
    [name.trim(), token]
  );
  const runner = result.rows[0];

  await logEvent('RUNNER_JOINED', runner.id, `${runner.name} csatlakozott a játékhoz.`);
  res.json({ token, id: runner.id, name: runner.name });
}));

app.post('/api/auth/hunter', (req, res) => {
  const { pin } = req.body;
  if (pin === process.env.HUNTER_PIN) {
    res.cookie('hunter_auth', process.env.SESSION_SECRET, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production'
    });
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Helytelen PIN kód' });
  }
});

const checkHunter = (req, res, next) => {
  if (req.cookies.hunter_auth === process.env.SESSION_SECRET) {
    next();
  } else {
    res.status(401).json({ error: 'Nem jogosult' });
  }
};

const checkRunner = handleAsync(async (req, res, next) => {
  const token = req.headers.authorization;
  if (!token) return res.status(401).json({ error: 'Hiányzó token' });

  const result = await db.query('SELECT * FROM runners WHERE token = $1', [token]);
  if (!result.rows[0]) {
    return res.status(401).json({ error: 'Érvénytelen token' });
  }
  req.runner = result.rows[0];
  next();
});

// --- API ENDPOINTS ---
app.get('/api/state', handleAsync(async (req, res) => {
  const [settings, runners, events] = await Promise.all([
    db.query('SELECT * FROM settings WHERE id = 1'),
    db.query(`
      SELECT r.id, r.name, r.tracking_enabled, r.is_most_wanted,
             r.last_latitude, r.last_longitude, r.last_accuracy, r.last_location_at,
              r.last_speed, r.live_latitude, r.live_longitude, r.live_accuracy,
              r.live_speed, r.live_location_at, r.penalty_until,
              r.last_hunter_distance_km, r.last_hunter_speed, r.last_hunter_location_at,
             CASE WHEN r.penalty_until IS NOT NULL AND r.penalty_until > NOW() THEN r.live_latitude ELSE NULL END AS live_latitude,
             CASE WHEN r.penalty_until IS NOT NULL AND r.penalty_until > NOW() THEN r.live_longitude ELSE NULL END AS live_longitude,
             CASE WHEN r.penalty_until IS NOT NULL AND r.penalty_until > NOW() THEN r.live_accuracy ELSE NULL END AS live_accuracy,
             CASE WHEN r.penalty_until IS NOT NULL AND r.penalty_until > NOW() THEN r.live_speed ELSE NULL END AS live_speed,
             CASE WHEN r.penalty_until IS NOT NULL AND r.penalty_until > NOW() THEN r.live_location_at ELSE NULL END AS live_location_at,
             r.created_at, r.location_cycle_started_at,
             (r.penalty_until IS NOT NULL AND r.penalty_until > NOW())
               AS live_tracking_required,
             COALESCE(location_cycle_started_at, last_location_at, created_at)
               + (s.location_interval * INTERVAL '1 minute') AS next_location_at
      FROM runners r
      CROSS JOIN settings s
      ORDER BY r.id
    `),
    db.query('SELECT * FROM events ORDER BY created_at DESC LIMIT 50')
  ]);

  const hunter = (await db.query('SELECT * FROM hunter_presence WHERE id = 1')).rows[0] || null;
  res.json({
    settings: settings.rows[0],
    runners: runners.rows,
    events: events.rows,
    hunter
  });
}));

app.get('/api/runner/me', checkRunner, handleAsync(async (req, res) => {
  const result = await db.query(`
    SELECT r.id, r.name, r.tracking_enabled, r.is_most_wanted,
           r.last_latitude, r.last_longitude, r.last_accuracy,
           r.last_speed, r.live_latitude, r.live_longitude, r.live_accuracy,
           r.live_speed, r.live_location_at, r.penalty_until,
           r.last_hunter_distance_km, r.last_hunter_speed, r.last_hunter_location_at,
           r.last_location_at, r.created_at, r.location_cycle_started_at,
           (r.penalty_until IS NOT NULL AND r.penalty_until > NOW())
             AS live_tracking_required,
           COALESCE(r.location_cycle_started_at, r.last_location_at, r.created_at)
             + (s.location_interval * INTERVAL '1 minute') AS next_location_at,
           s.id AS settings_id, s.location_interval, s.distance_enabled,
           s.updated_at, s.game_title, s.game_description,
           s.runner_instructions, s.announcement, s.live_update_interval,
           s.speed_enabled, s.alerts_enabled, s.high_accuracy_enabled,
           s.penalty_enabled, s.game_status, s.announcement_priority,
           s.accent_color
    FROM runners r
    CROSS JOIN settings s
    WHERE r.id = $1 AND s.id = 1
  `, [req.runner.id]);
  const row = result.rows[0];
  const {
    settings_id: settingId,
    location_interval,
    distance_enabled,
    updated_at,
    game_title,
    game_description,
    runner_instructions,
    announcement,
     live_update_interval,
     speed_enabled,
     alerts_enabled,
     high_accuracy_enabled,
     penalty_enabled,
     game_status,
     announcement_priority,
     accent_color,
    ...runner
  } = row;
  res.json({
    runner,
    settings: {
      id: settingId,
      location_interval,
      distance_enabled,
      updated_at,
      game_title,
      game_description,
      runner_instructions,
       announcement,
       live_update_interval,
       speed_enabled,
       alerts_enabled,
       high_accuracy_enabled,
       penalty_enabled,
       game_status,
       announcement_priority,
       accent_color
    }
  });
}));

app.get('/api/runner/updates', checkRunner, handleAsync(async (req, res) => {
  const [settings, messages, runner, hunter] = await Promise.all([
    db.query('SELECT * FROM settings WHERE id = 1'),
    db.query(`
      SELECT id, runner_id, message, priority, created_at
      FROM messages
      WHERE runner_id IS NULL OR runner_id = $1
      ORDER BY created_at DESC
      LIMIT 20
    `, [req.runner.id]),
    db.query(`
      SELECT r.id, r.name, r.is_most_wanted, r.last_location_at,
             r.location_cycle_started_at, r.live_latitude, r.live_longitude,
             r.live_accuracy, r.live_speed, r.live_location_at, r.penalty_until,
             r.last_hunter_distance_km, r.last_hunter_speed, r.last_hunter_location_at,
             (r.penalty_until IS NOT NULL AND r.penalty_until > NOW())
               AS live_tracking_required,
             COALESCE(r.location_cycle_started_at, r.last_location_at, r.created_at)
               + (s.location_interval * INTERVAL '1 minute') AS next_location_at
      FROM runners r
      CROSS JOIN settings s
      WHERE r.id = $1 AND s.id = 1
    `, [req.runner.id]),
    db.query('SELECT * FROM hunter_presence WHERE id = 1')
  ]);

  const currentRunner = runner.rows[0];
  const currentHunter = hunter.rows[0] || null;
  res.json({
    settings: settings.rows[0],
    messages: messages.rows,
    runner: currentRunner,
    hunter: currentHunter ? {
      ...currentHunter
    } : null
  });
}));

app.post('/api/location', checkRunner, handleAsync(async (req, res) => {
  const { latitude, longitude, accuracy, speed } = req.body;
  if (![latitude, longitude].every((value) => Number.isFinite(Number(value)))) {
    return res.status(400).json({ error: 'Érvénytelen helyadat' });
  }

  const schedule = await db.query(`
    SELECT r.last_location_at, r.location_cycle_started_at, r.created_at,
           s.location_interval,
           COALESCE(r.location_cycle_started_at, r.last_location_at, r.created_at)
             + (s.location_interval * INTERVAL '1 minute') AS next_location_at
    FROM runners r
    CROSS JOIN settings s
    WHERE r.id = $1 AND s.id = 1
  `, [req.runner.id]);
  const nextLocationAt = new Date(schedule.rows[0].next_location_at);
  if (req.runner.last_location_at && Date.now() < nextLocationAt.getTime()) {
    return res.status(429).json({
      error: 'A helyzetküldés még nem esedékes.',
      next_location_at: nextLocationAt.toISOString()
    });
  }

  const now = new Date();
  const hunterPresence = (await db.query(
    'SELECT latitude, longitude, speed, location_at FROM hunter_presence WHERE id = 1'
  )).rows[0] || null;
  const hunterDistance = hunterPresence
    ? distanceInKm(latitude, longitude, hunterPresence.latitude, hunterPresence.longitude)
    : null;
  await db.query(
    `UPDATE runners
     SET last_latitude = $1, last_longitude = $2, last_accuracy = $3,
         last_speed = $4, last_location_at = $5, location_cycle_started_at = $5,
         live_latitude = $1, live_longitude = $2, live_accuracy = $3,
         live_speed = $4, live_location_at = $5,
         last_hunter_distance_km = $6, last_hunter_speed = $7,
         last_hunter_location_at = $8
     WHERE id = $9`,
    [
      latitude, longitude, accuracy ?? null, finiteNumber(speed), now,
      hunterDistance, hunterPresence ? finiteNumber(hunterPresence.speed) : null,
      hunterPresence?.location_at || null, req.runner.id
    ]
  );
  await db.query(
    'INSERT INTO locations (runner_id, latitude, longitude, accuracy, speed) VALUES ($1, $2, $3, $4, $5)',
    [req.runner.id, latitude, longitude, accuracy ?? null, finiteNumber(speed)]
  );
  await logEvent('LOCATION_UPDATE', req.runner.id, `${req.runner.name} új helyzetet küldött.`);
  const next = new Date(now.getTime() + Number(schedule.rows[0].location_interval) * 60000);
  res.json({
    success: true,
    last_location_at: now.toISOString(),
    next_location_at: next.toISOString(),
    hunter: hunterPresence ? {
      ...hunterPresence,
      distance_km: hunterDistance
    } : null
  });
}));

app.post('/api/runner/live-location', checkRunner, handleAsync(async (req, res) => {
  const { latitude, longitude, accuracy, speed } = req.body;
  if (![latitude, longitude].every((value) => Number.isFinite(Number(value)))) {
    return res.status(400).json({ error: 'Érvénytelen élő helyadat' });
  }

  const currentRunner = (await db.query(
    'SELECT penalty_until FROM runners WHERE id = $1'
  )).rows[0];
  const penaltyActive = currentRunner?.penalty_until
    && new Date(currentRunner.penalty_until).getTime() > Date.now();
  if (!penaltyActive) {
    return res.status(403).json({ error: 'Élő helyzetküldés csak aktív büntetés alatt engedélyezett.' });
  }

  await db.query(
    `UPDATE runners
     SET live_latitude = $1, live_longitude = $2, live_accuracy = $3,
         live_speed = $4, live_location_at = NOW()
     WHERE id = $5`,
    [latitude, longitude, accuracy ?? null, finiteNumber(speed), req.runner.id]
  );
  res.json({ success: true });
}));

// --- HUNTER API ---
app.post('/api/settings', checkHunter, handleAsync(async (req, res) => {
  const current = (await db.query('SELECT * FROM settings WHERE id = 1')).rows[0];
  const locationInterval = Number(req.body.location_interval);
  const liveUpdateInterval = Number(req.body.live_update_interval);
  const nextInterval = Number.isInteger(locationInterval) && locationInterval > 0
    ? locationInterval
    : current.location_interval;
  const nextLiveUpdateInterval = Number.isInteger(liveUpdateInterval) && liveUpdateInterval >= 1 && liveUpdateInterval <= 10
    ? liveUpdateInterval
    : current.live_update_interval;
  const nextTitle = typeof req.body.game_title === 'string'
    ? req.body.game_title.trim().slice(0, 120) || current.game_title
    : current.game_title;
  const nextDescription = typeof req.body.game_description === 'string'
    ? req.body.game_description.trim().slice(0, 500)
    : current.game_description;
  const nextInstructions = typeof req.body.runner_instructions === 'string'
    ? req.body.runner_instructions.trim().slice(0, 1000)
    : current.runner_instructions;
  const nextAnnouncement = typeof req.body.announcement === 'string'
    ? req.body.announcement.trim().slice(0, 500)
    : current.announcement;
  const nextDistanceEnabled = typeof req.body.distance_enabled === 'boolean'
    ? req.body.distance_enabled
    : current.distance_enabled;
  const nextSpeedEnabled = typeof req.body.speed_enabled === 'boolean'
    ? req.body.speed_enabled
    : current.speed_enabled;
  const nextAlertsEnabled = typeof req.body.alerts_enabled === 'boolean'
    ? req.body.alerts_enabled
    : current.alerts_enabled;
  const nextHighAccuracyEnabled = typeof req.body.high_accuracy_enabled === 'boolean'
    ? req.body.high_accuracy_enabled
    : current.high_accuracy_enabled;
  const nextPenaltyEnabled = typeof req.body.penalty_enabled === 'boolean'
    ? req.body.penalty_enabled
    : current.penalty_enabled;
  const nextGameStatus = ['waiting', 'live', 'paused', 'finished'].includes(req.body.game_status)
    ? req.body.game_status
    : current.game_status;
  const nextAnnouncementPriority = getPriority(req.body.announcement_priority || current.announcement_priority);
  const nextAccentColor = typeof req.body.accent_color === 'string'
    && /^#[0-9a-f]{6}$/i.test(req.body.accent_color)
    ? req.body.accent_color
    : current.accent_color;

  await db.query(`
    UPDATE settings
    SET location_interval = $1, game_title = $2, game_description = $3,
        runner_instructions = $4, announcement = $5,
        distance_enabled = $6, live_update_interval = $7,
        speed_enabled = $8, alerts_enabled = $9,
        high_accuracy_enabled = $10, penalty_enabled = $11,
        game_status = $12, announcement_priority = $13,
        accent_color = $14, updated_at = NOW()
    WHERE id = 1
  `, [
    nextInterval, nextTitle, nextDescription, nextInstructions, nextAnnouncement,
    nextDistanceEnabled, nextLiveUpdateInterval, nextSpeedEnabled, nextAlertsEnabled,
    nextHighAccuracyEnabled, nextPenaltyEnabled, nextGameStatus,
    nextAnnouncementPriority, nextAccentColor
  ]);

  if (nextInterval !== current.location_interval || nextLiveUpdateInterval !== current.live_update_interval) {
    await db.query('UPDATE runners SET location_cycle_started_at = NOW()');
    await logEvent(
      'SETTINGS_CHANGED',
      null,
      `Játékbeállítások frissítve. Új intervallum: ${nextInterval} perc, élő frissítés: ${nextLiveUpdateInterval} mp.`
    );
  }
  res.json({ success: true, settings: (await db.query('SELECT * FROM settings WHERE id = 1')).rows[0] });
}));

app.post('/api/hunter/reset', checkHunter, handleAsync(async (req, res) => {
  await db.query('TRUNCATE locations, messages, events, runners RESTART IDENTITY CASCADE');
  await db.query(`
    UPDATE settings
    SET location_interval = 20,
        live_update_interval = 1,
        distance_enabled = TRUE,
        speed_enabled = TRUE,
        alerts_enabled = TRUE,
        high_accuracy_enabled = TRUE,
        penalty_enabled = TRUE,
        game_status = 'waiting',
        announcement_priority = 'important',
        accent_color = '#9b87f5',
        game_title = 'Most Wanted - A hajsza',
        game_description = 'A vadászok követik a menekülőket. A helyzeted automatikusan frissül.',
        runner_instructions = 'Tartsd nyitva az oldalt, engedélyezd a helymeghatározást, és figyeld az automatikus jelzések visszaszámlálóját.',
        announcement = 'A játék újraindult. Készülj a csatlakozásra.',
        updated_at = NOW()
    WHERE id = 1
  `);
  res.json({ success: true });
}));

app.post('/api/hunter/most-wanted', checkHunter, handleAsync(async (req, res) => {
  const runnerId = req.body.runner_id ? Number(req.body.runner_id) : null;
  await db.query('UPDATE runners SET is_most_wanted = FALSE');

  if (runnerId) {
    const runnerResult = await db.query(
      'SELECT name FROM runners WHERE id = $1',
      [runnerId]
    );
    const runner = runnerResult.rows[0];
    if (!runner) return res.status(404).json({ error: 'A játékos nem található' });

    await db.query(
      'UPDATE runners SET is_most_wanted = TRUE WHERE id = $1',
      [runnerId]
    );
    await logEvent('MOST_WANTED_SET', runnerId, `${runner.name} lett a Most Wanted!`);
  } else {
    await logEvent('MOST_WANTED_CLEARED', null, 'Most Wanted státusz törölve.');
  }

  res.json({ success: true });
}));

app.post('/api/hunter/penalty', checkHunter, handleAsync(async (req, res) => {
  const runnerId = Number(req.body.runner_id);
  const minutes = Number(req.body.minutes);
  if (!Number.isInteger(runnerId) || !Number.isInteger(minutes) || minutes < 0 || minutes > 10) {
    return res.status(400).json({ error: 'A büntetés 0 és 10 perc közötti egész szám lehet.' });
  }

  const runnerResult = await db.query('SELECT name FROM runners WHERE id = $1', [runnerId]);
  const runner = runnerResult.rows[0];
  if (!runner) return res.status(404).json({ error: 'A játékos nem található' });

  const penaltyUntil = minutes === 0 ? null : new Date(Date.now() + minutes * 60 * 1000);
  await db.query('UPDATE runners SET penalty_until = $1 WHERE id = $2', [penaltyUntil, runnerId]);
  if (minutes > 0) {
    await db.query(
      'INSERT INTO messages (runner_id, message, priority) VALUES ($1, $2, $3)',
      [
        runnerId,
        `Büntetést kaptál: a helyzeted ${minutes} percig folyamatosan látható lesz a vadász számára.`,
        'urgent'
      ]
    );
  } else {
    await db.query(
      'INSERT INTO messages (runner_id, message, priority) VALUES ($1, $2, $3)',
      [runnerId, 'A folyamatos láthatósági büntetésed megszűnt.', 'important']
    );
  }
  await logEvent(
    minutes === 0 ? 'PENALTY_CLEARED' : 'PENALTY_SET',
    runnerId,
    minutes === 0
      ? `${runner.name} büntetése lejárt vagy törölve lett.`
      : `${runner.name} ${minutes} perces folyamatos láthatóságot kapott.`
  );
  res.json({ success: true, penalty_until: penaltyUntil ? penaltyUntil.toISOString() : null });
}));

app.post('/api/hunter/location', checkHunter, handleAsync(async (req, res) => {
  const { latitude, longitude, accuracy, speed, timestamp } = req.body;
  if (![latitude, longitude].every((value) => Number.isFinite(Number(value)))) {
    return res.status(400).json({ error: 'Érvénytelen vadász helyadat' });
  }

  const previous = (await db.query(
    'SELECT latitude, longitude, location_at, speed FROM hunter_presence WHERE id = 1'
  )).rows[0] || null;

  const now = new Date();
  const clientSpeed = finiteNumber(speed);
  let measuredSpeed = clientSpeed !== null && clientSpeed >= 0 && clientSpeed <= 100
    ? clientSpeed
    : null;

  if (measuredSpeed === null && previous && Number.isFinite(Number(previous.latitude))
      && Number.isFinite(Number(previous.longitude)) && previous.location_at) {
    const elapsedSeconds = (now.getTime() - new Date(previous.location_at).getTime()) / 1000;
    const distanceKm = distanceInKm(previous.latitude, previous.longitude, latitude, longitude);
    const meters = Number.isFinite(distanceKm) ? distanceKm * 1000 : null;
    if (elapsedSeconds > 0.5 && Number.isFinite(meters)) {
      const derivedSpeed = meters / elapsedSeconds;
      if (derivedSpeed >= 0 && derivedSpeed <= 100) measuredSpeed = derivedSpeed;
    }
  }

  await db.query(
    `UPDATE hunter_presence
     SET latitude = $1, longitude = $2, accuracy = $3, speed = $4,
         location_at = $5, updated_at = NOW()
     WHERE id = 1`,
    [latitude, longitude, accuracy ?? null, measuredSpeed, now]
  );
  res.json({ success: true, speed: measuredSpeed, location_at: now.toISOString() });
}));

app.post('/api/hunter/message', checkHunter, handleAsync(async (req, res) => {
  const { runner_id: runnerId, message } = req.body;
  const priority = getPriority(req.body.priority);
  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Az üzenet nem lehet üres' });
  }

  const normalizedRunnerId = runnerId ? Number(runnerId) : null;
  await db.query(
    'INSERT INTO messages (runner_id, message, priority) VALUES ($1, $2, $3)',
    [normalizedRunnerId, message.trim(), priority]
  );
  await logEvent('MESSAGE_SENT', normalizedRunnerId, `[${priority.toUpperCase()}] Üzenet: ${message.trim()}`);
  res.json({ success: true });
}));

app.post('/api/runner/leave', checkRunner, handleAsync(async (req, res) => {
  await db.query('DELETE FROM runners WHERE id = $1', [req.runner.id]);
  res.json({ success: true });
}));

app.get('/healthz', (req, res) => {
  res.json({ ok: true });
});

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Szerverhiba' });
});

const PORT = process.env.PORT || 3000;
ensureDatabaseSchema()
  .then(() => {
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`Szerver fut a ${PORT} porton`);
    });
  })
  .catch((error) => {
    console.error('Adatbázis inicializálási hiba:', error);
    process.exit(1);
  });