import 'dotenv/config';
import Database from 'better-sqlite3';
import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import fs from 'node:fs';
import path from 'node:path';

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID;
if (!token || !clientId || !guildId) throw new Error('Missing DISCORD_TOKEN, CLIENT_ID or GUILD_ID in .env');

const dbPath = process.env.DATABASE_PATH || './data/tgs-tracker.db';
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS games (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE COLLATE NOCASE, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS tournaments (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE COLLATE NOCASE, game_id INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(game_id) REFERENCES games(id));
CREATE TABLE IF NOT EXISTS players (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE COLLATE NOCASE, discord_id TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS races (id INTEGER PRIMARY KEY AUTOINCREMENT, tournament_id INTEGER NOT NULL, race_no INTEGER NOT NULL, track TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(tournament_id, race_no), FOREIGN KEY(tournament_id) REFERENCES tournaments(id));
CREATE TABLE IF NOT EXISTS results (id INTEGER PRIMARY KEY AUTOINCREMENT, race_id INTEGER NOT NULL, player_id INTEGER NOT NULL, points REAL NOT NULL DEFAULT 0, position INTEGER, FOREIGN KEY(race_id) REFERENCES races(id), FOREIGN KEY(player_id) REFERENCES players(id), UNIQUE(race_id, player_id));
`);

// Migrate databases created by older versions.
try { db.prepare('ALTER TABLE tournaments ADD COLUMN game_id INTEGER').run(); } catch (_) {}
const general = db.prepare('SELECT id FROM games WHERE name = ? COLLATE NOCASE').get('General') as any;
if (!general) db.prepare('INSERT INTO games(name) VALUES(?)').run('General');
const generalId = (db.prepare('SELECT id FROM games WHERE name = ? COLLATE NOCASE').get('General') as any).id;
db.prepare('UPDATE tournaments SET game_id = ? WHERE game_id IS NULL').run(generalId);

const commands = [
  new SlashCommandBuilder().setName('help').setDescription('Show TGS Game Tracker commands'),
  new SlashCommandBuilder().setName('game').setDescription('Create a game').addStringOption(o => o.setName('name').setDescription('Game name').setRequired(true)),
  new SlashCommandBuilder().setName('tournament').setDescription('Create a tournament').addStringOption(o => o.setName('name').setDescription('Tournament name').setRequired(true)).addStringOption(o => o.setName('game').setDescription('Game name').setRequired(true)),
  new SlashCommandBuilder().setName('player').setDescription('Add a player').addStringOption(o => o.setName('name').setDescription('Player name').setRequired(true)).addUserOption(o => o.setName('discord').setDescription('Optional Discord account')),
  new SlashCommandBuilder().setName('race').setDescription('Record a race and results').addStringOption(o => o.setName('tournament').setDescription('Tournament name').setRequired(true)).addIntegerOption(o => o.setName('number').setDescription('Race number').setRequired(true)).addStringOption(o => o.setName('track').setDescription('Track/map/round name').setRequired(true)).addStringOption(o => o.setName('results').setDescription('Player=points,Player=points OR 1:Player=points').setRequired(true)),
  new SlashCommandBuilder().setName('tournaments').setDescription('List tournaments').addStringOption(o => o.setName('game').setDescription('Optional game filter')),
  new SlashCommandBuilder().setName('players').setDescription('List registered players'),
  new SlashCommandBuilder().setName('tournament-report').setDescription('Full tournament report').addStringOption(o => o.setName('tournament').setDescription('Tournament name').setRequired(true)),
  new SlashCommandBuilder().setName('player-report').setDescription('Full player report across tournaments').addStringOption(o => o.setName('player').setDescription('Player name').setRequired(true)).addStringOption(o => o.setName('game').setDescription('Optional game filter')),
  new SlashCommandBuilder().setName('player-history').setDescription('Player race-by-race history').addStringOption(o => o.setName('player').setDescription('Player name').setRequired(true)).addStringOption(o => o.setName('game').setDescription('Optional game filter')),
  new SlashCommandBuilder().setName('game-report').setDescription('Game-wide tournament and player report').addStringOption(o => o.setName('game').setDescription('Game name').setRequired(true))
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(token);
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
  console.log('Slash commands registered.');
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
function getGame(name: string) { return db.prepare('SELECT * FROM games WHERE name = ? COLLATE NOCASE').get(name) as any; }
function getTournament(name: string) { return db.prepare('SELECT t.*, g.name game_name FROM tournaments t LEFT JOIN games g ON g.id=t.game_id WHERE t.name = ? COLLATE NOCASE').get(name) as any; }
function getPlayer(name: string) { return db.prepare('SELECT * FROM players WHERE name = ? COLLATE NOCASE').get(name) as any; }
function clean(value: string, max = 3500) { return value.length > max ? value.slice(0, max - 20) + '\n…report truncated' : value; }

function parseResults(raw: string) {
  const entries = raw.split(',').map(x => x.trim()).filter(Boolean).map((x, index) => {
    const m = x.match(/^(?:(\d+)\s*:\s*)?(.+?)\s*=\s*(-?\d+(?:\.\d+)?)$/);
    if (!m) return null;
    return { position: m[1] ? Number(m[1]) : null, name: m[2].trim(), points: Number(m[3]), inputOrder: index };
  });
  if (!entries.length || entries.some(x => !x || !x.name || !Number.isFinite(x.points))) return null;
  const valid = entries as {position:number|null,name:string,points:number,inputOrder:number}[];
  const sorted = [...valid].sort((a,b) => b.points - a.points || a.inputOrder - b.inputOrder);
  return valid.map(e => ({ ...e, position: e.position ?? sorted.findIndex(x => x === e) + 1 }));
}

async function handle(i: ChatInputCommandInteraction) {
  try {
    if (i.commandName === 'help') {
      await i.reply('**TGS Game Tracker**\n\n`/game name:` create a game\n`/tournament name: game:` create a tournament for any game\n`/player name:` register a player\n`/race tournament: number: track: results:` save race results\n`/tournaments game:` list tournaments, optionally by game\n`/players:` list players\n`/tournament-report tournament:` complete tournament report\n`/player-report player: game:` complete player report\n`/player-history player: game:` race history\n`/game-report game:` game-wide report\n\nResults: `Player1=25,Player2=18,Player3=15` (positions auto-calculated) or `1:Player1=25,2:Player2=18`.');
      return;
    }

    if (i.commandName === 'game') {
      const name = i.options.getString('name', true).trim();
      db.prepare('INSERT INTO games(name) VALUES(?)').run(name);
      await i.reply(`🎮 Game **${name}** created.`); return;
    }

    if (i.commandName === 'tournament') {
      const name = i.options.getString('name', true).trim();
      const gameName = i.options.getString('game', true).trim();
      const game = getGame(gameName);
      if (!game) { await i.reply(`❌ Game **${gameName}** not found. Create it first with \`/game\`.`); return; }
      db.prepare('INSERT INTO tournaments(name, game_id) VALUES(?, ?)').run(name, game.id);
      await i.reply(`🏆 Tournament **${name}** created under 🎮 **${game.name}**.`); return;
    }

    if (i.commandName === 'player') {
      const name = i.options.getString('name', true).trim(); const user = i.options.getUser('discord');
      db.prepare('INSERT INTO players(name, discord_id) VALUES(?, ?)').run(name, user?.id ?? null);
      await i.reply(`👤 Player **${name}** added.`); return;
    }

    if (i.commandName === 'race') {
      const tournamentName = i.options.getString('tournament', true).trim();
      const number = i.options.getInteger('number', true);
      const track = i.options.getString('track', true).trim();
      const parsed = parseResults(i.options.getString('results', true));
      const t = getTournament(tournamentName);
      if (!t) { await i.reply('❌ Tournament not found.'); return; }
      if (!parsed) { await i.reply('❌ Invalid results. Use `Player1=25,Player2=18` or `1:Player1=25,2:Player2=18`.'); return; }
      const tx = db.transaction(() => {
        const race = db.prepare('INSERT INTO races(tournament_id,race_no,track) VALUES(?,?,?)').run(t.id, number, track);
        for (const e of parsed) {
          let p = getPlayer(e.name);
          if (!p) { const r = db.prepare('INSERT INTO players(name) VALUES(?)').run(e.name); p = { id: Number(r.lastInsertRowid), name: e.name }; }
          db.prepare('INSERT INTO results(race_id,player_id,points,position) VALUES(?,?,?,?)').run(race.lastInsertRowid, p.id, e.points, e.position);
        }
      });
      tx();
      await i.reply(`🏁 Race **${number}** recorded for **${t.name}** (🎮 ${t.game_name}) on **${track}** with **${parsed.length} players**.`); return;
    }

    if (i.commandName === 'tournaments') {
      const gameName = i.options.getString('game');
      const rows = gameName ? db.prepare('SELECT t.name, g.name game_name FROM tournaments t JOIN games g ON g.id=t.game_id WHERE g.name=? COLLATE NOCASE ORDER BY t.created_at DESC').all(gameName) as any[] : db.prepare('SELECT t.name, g.name game_name FROM tournaments t LEFT JOIN games g ON g.id=t.game_id ORDER BY t.created_at DESC').all() as any[];
      const text = rows.length ? rows.map((r,n) => `${n+1}. **${r.name}** — 🎮 ${r.game_name || 'General'}`).join('\n') : 'No tournaments found.';
      await i.reply({ embeds: [new EmbedBuilder().setTitle(gameName ? `🏆 ${gameName} Tournaments` : '🏆 All Tournaments').setDescription(clean(text))] }); return;
    }

    if (i.commandName === 'players') {
      const rows = db.prepare(`SELECT p.name, COUNT(DISTINCT r.id) races, COALESCE(SUM(r.points),0) points FROM players p LEFT JOIN results r ON r.player_id=p.id GROUP BY p.id ORDER BY points DESC, p.name`).all() as any[];
      const text = rows.length ? rows.map((r,n) => `${n+1}. **${r.name}** — ${r.points} pts • ${r.races} races`).join('\n') : 'No players found.';
      await i.reply({ embeds: [new EmbedBuilder().setTitle('👥 TGS Players').setDescription(clean(text))] }); return;
    }

    if (i.commandName === 'tournament-report') {
      const name = i.options.getString('tournament', true); const t = getTournament(name);
      if (!t) { await i.reply('❌ Tournament not found.'); return; }
      const rows = db.prepare(`SELECT p.name, SUM(r.points) total, COUNT(r.id) races, MIN(r.position) best_position, AVG(r.position) avg_position FROM results r JOIN players p ON p.id=r.player_id JOIN races ra ON ra.id=r.race_id WHERE ra.tournament_id=? GROUP BY p.id ORDER BY total DESC, best_position ASC`).all(t.id) as any[];
      const races = db.prepare('SELECT race_no, track, created_at FROM races WHERE tournament_id=? ORDER BY race_no').all(t.id) as any[];
      const standings = rows.length ? rows.map((r,n) => `${n+1}. **${r.name}** — **${r.total} pts** • ${r.races} races • Best P${r.best_position ?? '-'} • Avg P${Number(r.avg_position || 0).toFixed(1)}`).join('\n') : 'No results recorded.';
      const raceList = races.length ? races.map(r => `Race ${r.race_no} — ${r.track}`).join('\n') : 'No races recorded.';
      await i.reply({ embeds: [new EmbedBuilder().setTitle(`🏆 ${t.name}`).setDescription(clean(`🎮 **Game:** ${t.game_name || 'General'}\n\n**STANDINGS**\n${standings}\n\n**RACES**\n${raceList}`))] }); return;
    }

    if (i.commandName === 'player-report' || i.commandName === 'player-history') {
      const name = i.options.getString('player', true); const gameName = i.options.getString('game'); const p = getPlayer(name);
      if (!p) { await i.reply('❌ Player not found.'); return; }
      const rows = db.prepare(`SELECT t.name tournament, g.name game_name, ra.race_no, ra.track, r.points, r.position FROM results r JOIN races ra ON ra.id=r.race_id JOIN tournaments t ON t.id=ra.tournament_id LEFT JOIN games g ON g.id=t.game_id WHERE r.player_id=? ${gameName ? 'AND g.name = ? COLLATE NOCASE' : ''} ORDER BY ra.created_at DESC, ra.race_no DESC`).all(...(gameName ? [p.id, gameName] : [p.id])) as any[];
      if (i.commandName === 'player-history') {
        const text = rows.length ? rows.map(r => `🎮 **${r.game_name || 'General'}** • **${r.tournament}** • Race ${r.race_no} • ${r.track} — **P${r.position ?? '-'} / ${r.points} pts**`).join('\n') : 'No races recorded.';
        await i.reply({ embeds: [new EmbedBuilder().setTitle(`📋 ${p.name} History`).setDescription(clean(text))] }); return;
      }
      const total = rows.reduce((s,r) => s + Number(r.points), 0);
      const tournaments = new Set(rows.map(r => r.tournament)).size;
      const wins = rows.filter(r => Number(r.position) === 1).length;
      const text = rows.length ? rows.map(r => `🎮 **${r.game_name || 'General'}** • ${r.tournament} • Race ${r.race_no} — **P${r.position ?? '-'}**, ${r.points} pts`).join('\n') : 'No records found.';
      await i.reply({ embeds: [new EmbedBuilder().setTitle(`📊 ${p.name} Report`).setDescription(clean(`**Total Points:** ${total}\n**Tournaments:** ${tournaments}\n**Races:** ${rows.length}\n**Wins (P1):** ${wins}\n\n${text}`))] }); return;
    }

    if (i.commandName === 'game-report') {
      const name = i.options.getString('game', true); const game = getGame(name);
      if (!game) { await i.reply('❌ Game not found.'); return; }
      const tournaments = db.prepare(`SELECT t.id,t.name,COUNT(DISTINCT ra.id) races FROM tournaments t LEFT JOIN races ra ON ra.tournament_id=t.id WHERE t.game_id=? GROUP BY t.id ORDER BY t.created_at DESC`).all(game.id) as any[];
      const players = db.prepare(`SELECT p.name,SUM(r.points) points,COUNT(r.id) races FROM results r JOIN players p ON p.id=r.player_id JOIN races ra ON ra.id=r.race_id JOIN tournaments t ON t.id=ra.tournament_id WHERE t.game_id=? GROUP BY p.id ORDER BY points DESC`).all(game.id) as any[];
      const tText = tournaments.length ? tournaments.map((r,n) => `${n+1}. **${r.name}** — ${r.races} races`).join('\n') : 'No tournaments.';
      const pText = players.length ? players.slice(0,25).map((r,n) => `${n+1}. **${r.name}** — ${r.points} pts • ${r.races} races`).join('\n') : 'No player results.';
      await i.reply({ embeds: [new EmbedBuilder().setTitle(`🎮 ${game.name} Report`).setDescription(clean(`**TOURNAMENTS**\n${tText}\n\n**PLAYER LEADERBOARD**\n${pText}`))] }); return;
    }
  } catch (e: any) {
    console.error(e);
    if (i.replied || i.deferred) await i.followUp('❌ Something went wrong. Check the server logs.');
    else await i.reply('❌ Something went wrong. Check the server logs.');
  }
}

client.once('ready', c => console.log(`Logged in as ${c.user.tag}`));
client.on('interactionCreate', async i => { if (i.isChatInputCommand()) await handle(i); });
registerCommands().then(() => client.login(token)).catch(err => { console.error(err); process.exit(1); });
