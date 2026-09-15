require('dotenv').config();
const Database = require('better-sqlite3');
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const fs = require('node:fs');
const path = require('node:path');

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID;

if (!token || !clientId || !guildId) {
  throw new Error('Missing DISCORD_TOKEN, CLIENT_ID or GUILD_ID in .env');
}

const dbPath = process.env.DATABASE_PATH || './data/tgs-tracker.db';
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS tournaments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  discord_id TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS races (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id INTEGER NOT NULL,
  race_no INTEGER NOT NULL,
  track TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tournament_id, race_no),
  FOREIGN KEY(tournament_id) REFERENCES tournaments(id)
);
CREATE TABLE IF NOT EXISTS results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  race_id INTEGER NOT NULL,
  player_id INTEGER NOT NULL,
  points REAL NOT NULL DEFAULT 0,
  position INTEGER,
  FOREIGN KEY(race_id) REFERENCES races(id),
  FOREIGN KEY(player_id) REFERENCES players(id),
  UNIQUE(race_id, player_id)
);
`);

const commands = [
  new SlashCommandBuilder().setName('help').setDescription('Show TGS Game Tracker commands'),
  new SlashCommandBuilder().setName('tournament').setDescription('Create a tournament').addStringOption(o => o.setName('name').setDescription('Tournament name').setRequired(true)),
  new SlashCommandBuilder().setName('player').setDescription('Add a player').addStringOption(o => o.setName('name').setDescription('Player name').setRequired(true)).addUserOption(o => o.setName('discord').setDescription('Optional Discord account')),
  new SlashCommandBuilder().setName('race').setDescription('Add a race and its results').addStringOption(o => o.setName('tournament').setDescription('Tournament name').setRequired(true)).addIntegerOption(o => o.setName('number').setDescription('Race number').setRequired(true)).addStringOption(o => o.setName('track').setDescription('Track name').setRequired(true)).addStringOption(o => o.setName('results').setDescription('Results: Player=points,Player=points').setRequired(true)),
  new SlashCommandBuilder().setName('stats').setDescription('Show player statistics').addStringOption(o => o.setName('player').setDescription('Player name').setRequired(true)),
  new SlashCommandBuilder().setName('tournament-stats').setDescription('Show tournament standings').addStringOption(o => o.setName('tournament').setDescription('Tournament name').setRequired(true)),
  new SlashCommandBuilder().setName('player-history').setDescription('Show a player race history').addStringOption(o => o.setName('player').setDescription('Player name').setRequired(true))
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(token);
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
  console.log('Slash commands registered.');
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

function getTournament(name) {
  return db.prepare('SELECT * FROM tournaments WHERE name = ? COLLATE NOCASE').get(name);
}
function getPlayer(name) {
  return db.prepare('SELECT * FROM players WHERE name = ? COLLATE NOCASE').get(name);
}

async function handle(i) {
  try {
    if (i.commandName === 'help') {
      await i.reply('**TGS Game Tracker**\n`/tournament name:` create tournament\n`/player name:` add player\n`/race tournament: number: track: results:` record a race\n`/stats player:` player totals\n`/tournament-stats tournament:` leaderboard\n`/player-history player:` race-by-race history\n\nRace results format: `Player1=25,Player2=18,Player3=15`');
      return;
    }

    if (i.commandName === 'tournament') {
      const name = i.options.getString('name', true).trim();
      db.prepare('INSERT INTO tournaments(name) VALUES(?)').run(name);
      await i.reply(`✅ Tournament **${name}** created.`);
      return;
    }

    if (i.commandName === 'player') {
      const name = i.options.getString('name', true).trim();
      const user = i.options.getUser('discord');
      db.prepare('INSERT INTO players(name, discord_id) VALUES(?, ?)').run(name, user ? user.id : null);
      await i.reply(`✅ Player **${name}** added.`);
      return;
    }

    if (i.commandName === 'race') {
      const tournamentName = i.options.getString('tournament', true).trim();
      const number = i.options.getInteger('number', true);
      const track = i.options.getString('track', true).trim();
      const raw = i.options.getString('results', true);
      const t = getTournament(tournamentName);

      if (!t) {
        await i.reply('❌ Tournament not found. Create it first with `/tournament`.');
        return;
      }

      const entries = raw.split(',').map(x => x.trim()).filter(Boolean).map(x => {
        const [name, pts] = x.split('=').map(s => s.trim());
        return { name, points: Number(pts) };
      });

      if (!entries.length || entries.some(x => !x.name || !Number.isFinite(x.points))) {
        await i.reply('❌ Invalid results. Use `Player1=25,Player2=18`.');
        return;
      }

      const tx = db.transaction(() => {
        const race = db.prepare('INSERT INTO races(tournament_id, race_no, track) VALUES(?, ?, ?)').run(t.id, number, track);
        for (const e of entries) {
          let p = getPlayer(e.name);
          if (!p) {
            const r = db.prepare('INSERT INTO players(name) VALUES(?)').run(e.name);
            p = { id: Number(r.lastInsertRowid), name: e.name };
          }
          db.prepare('INSERT INTO results(race_id, player_id, points, position) VALUES(?, ?, ?, ?)').run(race.lastInsertRowid, p.id, e.points, null);
        }
      });

      tx();
      await i.reply(`🏁 Race **${number}** recorded for **${tournamentName}** on **${track}** with **${entries.length} players**.`);
      return;
    }

    if (i.commandName === 'stats') {
      const name = i.options.getString('player', true);
      const p = getPlayer(name);
      if (!p) { await i.reply('❌ Player not found.'); return; }
      const s = db.prepare('SELECT COALESCE(SUM(points), 0) total, COUNT(*) races FROM results WHERE player_id = ?').get(p.id);
      const best = db.prepare('SELECT MAX(points) best FROM results WHERE player_id = ?').get(p.id);
      await i.reply({ embeds: [new EmbedBuilder().setTitle(`🏎️ ${p.name}`).addFields(
        { name: 'Total Points', value: String(s.total), inline: true },
        { name: 'Races', value: String(s.races), inline: true },
        { name: 'Best Race Points', value: String(best.best ?? 0), inline: true }
      )] });
      return;
    }

    if (i.commandName === 'tournament-stats') {
      const name = i.options.getString('tournament', true);
      const t = getTournament(name);
      if (!t) { await i.reply('❌ Tournament not found.'); return; }
      const rows = db.prepare(`SELECT p.name, SUM(r.points) total, COUNT(r.id) races FROM results r JOIN players p ON p.id = r.player_id JOIN races ra ON ra.id = r.race_id WHERE ra.tournament_id = ? GROUP BY p.id ORDER BY total DESC`).all(t.id);
      const text = rows.length ? rows.map((r, n) => `${n + 1}. **${r.name}** — ${r.total} pts (${r.races} races)`).join('\n') : 'No race results yet.';
      await i.reply({ embeds: [new EmbedBuilder().setTitle(`🏆 ${t.name} Standings`).setDescription(text)] });
      return;
    }

    if (i.commandName === 'player-history') {
      const name = i.options.getString('player', true);
      const p = getPlayer(name);
      if (!p) { await i.reply('❌ Player not found.'); return; }
      const rows = db.prepare(`SELECT t.name tournament, ra.race_no, ra.track, r.points FROM results r JOIN races ra ON ra.id = r.race_id JOIN tournaments t ON t.id = ra.tournament_id WHERE r.player_id = ? ORDER BY ra.created_at DESC, ra.race_no DESC LIMIT 20`).all(p.id);
      const text = rows.length ? rows.map(r => `**${r.tournament}** • Race ${r.race_no} • ${r.track} — **${r.points} pts**`).join('\n') : 'No races recorded.';
      await i.reply({ embeds: [new EmbedBuilder().setTitle(`📋 ${p.name} History`).setDescription(text)] });
      return;
    }
  } catch (e) {
    console.error(e);
    if (i.replied || i.deferred) await i.followUp('❌ Something went wrong. Check the server logs.');
    else await i.reply('❌ Something went wrong. Check the server logs.');
  }
}

client.once('ready', c => console.log(`Logged in as ${c.user.tag}`));
client.on('interactionCreate', async i => {
  if (i.isChatInputCommand()) await handle(i);
});

registerCommands()
  .then(() => client.login(token))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
