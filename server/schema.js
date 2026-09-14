const db = require('./db');

async function ensureSchema() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS settings (
      id SERIAL PRIMARY KEY,
      location_interval INTEGER DEFAULT 20,
      live_update_interval INTEGER DEFAULT 1,
      game_title VARCHAR(255) DEFAULT 'Most Wanted - A hajsza',
      game_description TEXT DEFAULT 'A vadászok követik a menekülőket.',
      runner_instructions TEXT DEFAULT 'Tartsd nyitva az oldalt és engedélyezd a helymeghatározást.',
      announcement TEXT DEFAULT 'A játék elindult.',
      announcement_priority VARCHAR(50) DEFAULT 'important',
      game_status VARCHAR(50) DEFAULT 'waiting',
      distance_enabled BOOLEAN DEFAULT TRUE,
      speed_enabled BOOLEAN DEFAULT TRUE,
      alerts_enabled BOOLEAN DEFAULT TRUE,
      high_accuracy_enabled BOOLEAN DEFAULT TRUE,
      penalty_enabled BOOLEAN DEFAULT TRUE,
      accent_color VARCHAR(50) DEFAULT '#9b87f5',
      updated_at TIMESTAMP DEFAULT NOW()
    );

    INSERT INTO settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

    CREATE TABLE IF NOT EXISTS hunter_presence (
      id SERIAL PRIMARY KEY,
      latitude DOUBLE PRECISION,
      longitude DOUBLE PRECISION,
      accuracy DOUBLE PRECISION,
      speed DOUBLE PRECISION,
      location_at TIMESTAMP,
      updated_at TIMESTAMP DEFAULT NOW()
    );

    INSERT INTO hunter_presence (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

    CREATE TABLE IF NOT EXISTS runners (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      token VARCHAR(255) NOT NULL,
      tracking_enabled BOOLEAN DEFAULT TRUE,
      is_most_wanted BOOLEAN DEFAULT FALSE,
      last_latitude DOUBLE PRECISION,
      last_longitude DOUBLE PRECISION,
      last_accuracy DOUBLE PRECISION,
      last_speed DOUBLE PRECISION,
      last_location_at TIMESTAMP,
      live_latitude DOUBLE PRECISION,
      live_longitude DOUBLE PRECISION,
      live_accuracy DOUBLE PRECISION,
      live_speed DOUBLE PRECISION,
      live_location_at TIMESTAMP,
      penalty_until TIMESTAMP,
      last_hunter_distance_km DOUBLE PRECISION,
      last_hunter_speed DOUBLE PRECISION,
      last_hunter_location_at TIMESTAMP,
      most_wanted_distance_km DOUBLE PRECISION,
      most_wanted_speed DOUBLE PRECISION,
      most_wanted_updated_at TIMESTAMP,
      location_cycle_started_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS locations (
      id SERIAL PRIMARY KEY,
      runner_id INTEGER REFERENCES runners(id) ON DELETE CASCADE,
      latitude DOUBLE PRECISION,
      longitude DOUBLE PRECISION,
      accuracy DOUBLE PRECISION,
      speed DOUBLE PRECISION,
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      runner_id INTEGER REFERENCES runners(id) ON DELETE CASCADE,
      message TEXT NOT NULL,
      priority VARCHAR(50) DEFAULT 'normal',
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      type VARCHAR(255) NOT NULL,
      runner_id INTEGER REFERENCES runners(id) ON DELETE SET NULL,
      data TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
}

module.exports = { ensureSchema };
