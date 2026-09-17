import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const dbPath = process.env.DATABASE_PATH || './data/tgs-tracker.db';
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma('foreign_keys = ON');

const tournamentCount = (db.prepare('SELECT COUNT(*) AS count FROM tournaments').get() as { count: number }).count;
const playerCount = (db.prepare('SELECT COUNT(*) AS count FROM players').get() as { count: number }).count;
const gameCount = (db.prepare('SELECT COUNT(*) AS count FROM games').get() as { count: number }).count;

console.log(`Found ${tournamentCount} tournament(s).`);
console.log(`Games will be preserved: ${gameCount}`);
console.log(`Players will be preserved: ${playerCount}`);

const reset = db.transaction(() => {
  // Foreign keys are enabled, so all tournament-owned rows are removed automatically.
  db.prepare('DELETE FROM tournaments').run();
});

reset();

db.exec('VACUUM');
console.log('✅ All tournaments, tournament players, races, results and fixtures have been deleted.');
console.log('✅ Games and registered players have been preserved.');
console.log('You can now create fresh tournaments with /tournament.');

db.close();
