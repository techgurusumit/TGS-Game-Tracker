import 'dotenv/config';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  ModalBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID;
if (!token || !clientId || !guildId) throw new Error('Missing DISCORD_TOKEN, CLIENT_ID or GUILD_ID in .env');

const dbPath = process.env.DATABASE_PATH || './data/tgs-tracker.db';
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS games (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS tournaments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  game_id INTEGER,
  password_hash TEXT,
  password_salt TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  created_by TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(game_id) REFERENCES games(id)
);
CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  discord_id TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS tournament_players (
  tournament_id INTEGER NOT NULL,
  player_id INTEGER NOT NULL,
  seed INTEGER,
  joined_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(tournament_id, player_id),
  FOREIGN KEY(tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE,
  FOREIGN KEY(player_id) REFERENCES players(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS races (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id INTEGER NOT NULL,
  race_no INTEGER NOT NULL,
  track TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tournament_id, race_no),
  FOREIGN KEY(tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  race_id INTEGER NOT NULL,
  player_id INTEGER NOT NULL,
  points REAL NOT NULL DEFAULT 0,
  position INTEGER,
  kd REAL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(race_id) REFERENCES races(id) ON DELETE CASCADE,
  FOREIGN KEY(player_id) REFERENCES players(id) ON DELETE CASCADE,
  UNIQUE(race_id, player_id)
);
CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id INTEGER NOT NULL,
  round_name TEXT NOT NULL,
  match_no INTEGER NOT NULL,
  player1_id INTEGER,
  player2_id INTEGER,
  winner_id INTEGER,
  score1 REAL,
  score2 REAL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tournament_id, round_name, match_no),
  FOREIGN KEY(tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE,
  FOREIGN KEY(player1_id) REFERENCES players(id) ON DELETE SET NULL,
  FOREIGN KEY(player2_id) REFERENCES players(id) ON DELETE SET NULL,
  FOREIGN KEY(winner_id) REFERENCES players(id) ON DELETE SET NULL
);
`);

// Safe migrations for databases from older versions.
const migrations = [
  ['tournaments', 'game_id', 'INTEGER'],
  ['tournaments', 'password_hash', 'TEXT'],
  ['tournaments', 'password_salt', 'TEXT'],
  ['tournaments', 'status', "TEXT NOT NULL DEFAULT 'draft'"],
  ['tournaments', 'created_by', 'TEXT'],
  ['tournaments', 'updated_at', 'TEXT DEFAULT CURRENT_TIMESTAMP'],
  ['results', 'kd', 'REAL'],
  ['results', 'created_at', 'TEXT DEFAULT CURRENT_TIMESTAMP'],
] as const;
for (const [table, column, definition] of migrations) {
  try { db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run(); } catch (_) { /* already exists */ }
}

const general = db.prepare('SELECT id FROM games WHERE name = ? COLLATE NOCASE').get('General') as any;
if (!general) db.prepare('INSERT INTO games(name) VALUES(?)').run('General');
const generalId = (db.prepare('SELECT id FROM games WHERE name = ? COLLATE NOCASE').get('General') as any).id;
db.prepare('UPDATE tournaments SET game_id = ? WHERE game_id IS NULL').run(generalId);
// Legacy tournaments had no password. Give them the documented legacy password.
const LEGACY_PASSWORD = 'TGS2026';
const legacyRows = db.prepare('SELECT id FROM tournaments WHERE password_hash IS NULL OR password_salt IS NULL').all() as any[];
for (const row of legacyRows) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(LEGACY_PASSWORD, salt);
  db.prepare('UPDATE tournaments SET password_hash=?, password_salt=? WHERE id=?').run(hash, salt, row.id);
}

function hashPassword(password: string, salt: string) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function makePassword(password: string) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: hashPassword(password, salt) };
}
function verifyPassword(password: string, hash: string, salt: string) {
  const actual = Buffer.from(hashPassword(password, salt), 'hex');
  const expected = Buffer.from(hash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
function clean(value: string, max = 3900) { return value.length > max ? value.slice(0, max - 30) + '\n…report truncated' : value; }
function getGame(name: string) { return db.prepare('SELECT * FROM games WHERE name=? COLLATE NOCASE').get(name) as any; }
function getTournament(name: string) { return db.prepare('SELECT t.*, g.name game_name FROM tournaments t LEFT JOIN games g ON g.id=t.game_id WHERE t.name=? COLLATE NOCASE').get(name) as any; }
function getTournamentById(id: number) { return db.prepare('SELECT t.*, g.name game_name FROM tournaments t LEFT JOIN games g ON g.id=t.game_id WHERE t.id=?').get(id) as any; }
function getPlayer(name: string) { return db.prepare('SELECT * FROM players WHERE name=? COLLATE NOCASE').get(name) as any; }
function ensurePlayer(name: string, discordId?: string | null) {
  let p = getPlayer(name);
  if (!p) {
    const r = db.prepare('INSERT INTO players(name,discord_id) VALUES(?,?)').run(name.trim(), discordId ?? null);
    p = { id: Number(r.lastInsertRowid), name: name.trim(), discord_id: discordId ?? null };
  } else if (discordId && !p.discord_id) {
    db.prepare('UPDATE players SET discord_id=? WHERE id=?').run(discordId, p.id);
    p.discord_id = discordId;
  }
  return p;
}
function addParticipant(tournamentId: number, playerId: number, seed?: number) {
  db.prepare('INSERT OR IGNORE INTO tournament_players(tournament_id,player_id,seed) VALUES(?,?,?)').run(tournamentId, playerId, seed ?? null);
}
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

const commands = [
  new SlashCommandBuilder().setName('help').setDescription('Show TGS Game Tracker commands'),
  new SlashCommandBuilder().setName('game').setDescription('Create a game').addStringOption(o => o.setName('name').setDescription('Game name').setRequired(true)),
  new SlashCommandBuilder().setName('tournament').setDescription('Create a tournament with password').addStringOption(o => o.setName('name').setDescription('Tournament name').setRequired(true)).addStringOption(o => o.setName('game').setDescription('Game name').setRequired(true)).addStringOption(o => o.setName('password').setDescription('Tournament password').setRequired(true).setMinLength(4)).addStringOption(o => o.setName('confirm_password').setDescription('Repeat password').setRequired(true).setMinLength(4)),
  new SlashCommandBuilder().setName('tournament-manage').setDescription('Open tournament management panel'),
  new SlashCommandBuilder().setName('tournament-player').setDescription('Manage tournament players').addSubcommand(s => s.setName('add').setDescription('Add a player').addStringOption(o => o.setName('tournament').setDescription('Tournament name').setRequired(true)).addStringOption(o => o.setName('player').setDescription('Player name').setRequired(true)).addUserOption(o => o.setName('discord').setDescription('Optional Discord account'))).addSubcommand(s => s.setName('remove').setDescription('Remove a player').addStringOption(o => o.setName('tournament').setDescription('Tournament name').setRequired(true)).addStringOption(o => o.setName('player').setDescription('Player name').setRequired(true))),
  new SlashCommandBuilder().setName('player').setDescription('Add or link a player').addStringOption(o => o.setName('name').setDescription('Player name').setRequired(true)).addUserOption(o => o.setName('discord').setDescription('Optional Discord account')),
  new SlashCommandBuilder().setName('race').setDescription('Record a race and results').addStringOption(o => o.setName('tournament').setDescription('Tournament name').setRequired(true)).addIntegerOption(o => o.setName('number').setDescription('Race number').setRequired(true).setMinValue(1)).addStringOption(o => o.setName('track').setDescription('Track/map/round').setRequired(true)).addStringOption(o => o.setName('results').setDescription('Player=points,Player=points or 1:Player=points').setRequired(true)),
  new SlashCommandBuilder().setName('tournaments').setDescription('List tournaments').addStringOption(o => o.setName('game').setDescription('Optional game filter')),
  new SlashCommandBuilder().setName('players').setDescription('List registered players'),
  new SlashCommandBuilder().setName('tournament-report').setDescription('Full tournament report').addStringOption(o => o.setName('tournament').setDescription('Tournament name').setRequired(true)),
  new SlashCommandBuilder().setName('player-report').setDescription('Full player report').addStringOption(o => o.setName('player').setDescription('Player name').setRequired(true)).addStringOption(o => o.setName('game').setDescription('Optional game filter')),
  new SlashCommandBuilder().setName('player-history').setDescription('Player race history').addStringOption(o => o.setName('player').setDescription('Player name').setRequired(true)).addStringOption(o => o.setName('game').setDescription('Optional game filter')),
  new SlashCommandBuilder().setName('game-report').setDescription('Game-wide report').addStringOption(o => o.setName('game').setDescription('Game name').setRequired(true)),
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(token!);
  await rest.put(Routes.applicationGuildCommands(clientId!, guildId!), { body: commands });
  console.log(`Registered ${commands.length} slash commands.`);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

function managementPanel() {
  const tournaments = db.prepare('SELECT t.id,t.name,g.name game_name,t.status FROM tournaments t LEFT JOIN games g ON g.id=t.game_id ORDER BY t.created_at DESC LIMIT 25').all() as any[];
  if (!tournaments.length) return { content: '❌ No tournaments found. Create one with `/tournament`.' };
  const select = new StringSelectMenuBuilder().setCustomId('tgs:tournament-select').setPlaceholder('Select a tournament').addOptions(tournaments.map(t => ({ label: t.name.slice(0,100), value: String(t.id), description: `${t.game_name || 'General'} • ${t.status}`.slice(0,100) })));
  return { content: '🏆 **TGS Tournament Manager**\nSelect a tournament below. Then use the management buttons.', components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)] };
}

function managerButtons(tournamentId: number) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`tgs:update:${tournamentId}`).setLabel('Update').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`tgs:delete:${tournamentId}`).setLabel('Delete').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`tgs:fixtures:${tournamentId}`).setLabel('Create Fixtures').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`tgs:report:${tournamentId}`).setLabel('Report').setStyle(ButtonStyle.Secondary),
  );
}

function passwordModal(action: string, tournamentId: number) {
  const modal = new ModalBuilder().setCustomId(`tgs:password:${action}:${tournamentId}`).setTitle(`${action === 'delete' ? 'Delete' : action === 'fixtures' ? 'Create Fixtures' : 'Update'} Tournament`);
  const input = new TextInputBuilder().setCustomId('password').setLabel('Tournament password').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(4).setPlaceholder('Enter tournament password');
  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
  return modal;
}

async function verifyTournamentAccess(i: ModalSubmitInteraction, action: string, tournamentId: number) {
  const t = getTournamentById(tournamentId);
  if (!t) { await i.reply({ content: '❌ Tournament no longer exists.', ephemeral: true }); return null; }
  const password = i.fields.getTextInputValue('password');
  if (!t.password_hash || !t.password_salt || !verifyPassword(password, t.password_hash, t.password_salt)) {
    await i.reply({ content: '❌ Incorrect tournament password.', ephemeral: true });
    return null;
  }
  return t;
}

function createFixtures(tournamentId: number) {
  const players = db.prepare(`SELECT p.id,p.name,tp.seed FROM tournament_players tp JOIN players p ON p.id=tp.player_id WHERE tp.tournament_id=? ORDER BY CASE WHEN tp.seed IS NULL THEN 1 ELSE 0 END, tp.seed, p.name`).all(tournamentId) as any[];
  if (players.length < 2) throw new Error('At least 2 tournament players are required.');
  db.prepare('DELETE FROM matches WHERE tournament_id=?').run(tournamentId);
  const size = Math.pow(2, Math.ceil(Math.log2(players.length)));
  const slots = [...players];
  while (slots.length < size) slots.push(null as any);
  const rounds = Math.log2(size);
  const firstRound = rounds === 1 ? 'Final' : rounds === 2 ? 'Semifinal' : rounds === 3 ? 'Quarterfinal' : 'Round of ' + size;
  const tx = db.transaction(() => {
    for (let n=0; n<size; n+=2) {
      const p1 = slots[n]; const p2 = slots[n+1];
      let status = 'pending';
      let winner: any = null;
      if (!p1 && !p2) status = 'bye';
      else if (!p1 || !p2) { winner = p1 || p2; status = 'bye'; }
      db.prepare('INSERT INTO matches(tournament_id,round_name,match_no,player1_id,player2_id,winner_id,status) VALUES(?,?,?,?,?,?,?)').run(tournamentId, firstRound, n/2+1, p1?.id ?? null, p2?.id ?? null, winner?.id ?? null, status);
    }
    db.prepare('UPDATE tournaments SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run('fixtures_created', tournamentId);
  });
  tx();
  return { players: players.length, size, firstRound };
}

async function handleCommand(i: ChatInputCommandInteraction) {
  if (i.commandName === 'help') {
    await i.reply('**TGS Game Tracker**\n\n🎮 `/game` — create a game\n🏆 `/tournament` — create a password-protected tournament\n🛠️ `/tournament-manage` — Update/Delete/Create Fixtures/Report panel\n👥 `/tournament-player` — add/remove tournament players\n👤 `/player` — register/link player\n🏁 `/race` — save race results\n📋 `/tournaments` `/players` — lists\n📊 `/tournament-report` `/player-report` `/player-history` `/game-report` — reports');
    return;
  }
  if (i.commandName === 'game') {
    const name = i.options.getString('name', true).trim();
    if (!name) { await i.reply('❌ Game name cannot be empty.'); return; }
    try { db.prepare('INSERT INTO games(name) VALUES(?)').run(name); await i.reply(`🎮 Game **${name}** created.`); } catch { await i.reply(`❌ Game **${name}** already exists.`); }
    return;
  }
  if (i.commandName === 'tournament') {
    const name = i.options.getString('name', true).trim();
    const gameName = i.options.getString('game', true).trim();
    const password = i.options.getString('password', true);
    const confirm = i.options.getString('confirm_password', true);
    if (password !== confirm) { await i.reply({ content: '❌ Password confirmation does not match.', ephemeral: true }); return; }
    if (password.length < 4) { await i.reply({ content: '❌ Password must be at least 4 characters.', ephemeral: true }); return; }
    const game = getGame(gameName);
    if (!game) { await i.reply({ content: `❌ Game **${gameName}** not found. Create it first with \/game.`, ephemeral: true }); return; }
    try {
      const {hash,salt} = makePassword(password);
      db.prepare('INSERT INTO tournaments(name,game_id,password_hash,password_salt,status,created_by) VALUES(?,?,?,?,?,?)').run(name, game.id, hash, salt, 'draft', i.user.id);
      await i.reply({ content: `🏆 Tournament **${name}** created under 🎮 **${game.name}**.\n🔐 Password protection is enabled. Keep the password safe; it is not shown again.`, ephemeral: true });
    } catch { await i.reply({ content: `❌ Tournament **${name}** already exists.`, ephemeral: true }); }
    return;
  }
  if (i.commandName === 'tournament-manage') { await i.reply({ ...managementPanel(), ephemeral: true }); return; }
  if (i.commandName === 'player') {
    const name = i.options.getString('name', true).trim(); const user = i.options.getUser('discord');
    try { ensurePlayer(name, user?.id); await i.reply(`👤 Player **${name}** is registered${user ? ` and linked to ${user}.` : '.'}`); } catch { await i.reply('❌ Could not register that player.'); }
    return;
  }
  if (i.commandName === 'tournament-player') {
    const sub = i.options.getSubcommand(); const t = getTournament(i.options.getString('tournament', true));
    if (!t) { await i.reply('❌ Tournament not found.'); return; }
    const name = i.options.getString('player', true).trim(); const p = getPlayer(name);
    if (sub === 'add') {
      const user = i.options.getUser('discord'); const player = p || ensurePlayer(name, user?.id);
      addParticipant(t.id, player.id);
      await i.reply(`✅ **${player.name}** added to **${t.name}**.`); return;
    }
    if (!p) { await i.reply('❌ Player not found.'); return; }
    const r = db.prepare('DELETE FROM tournament_players WHERE tournament_id=? AND player_id=?').run(t.id,p.id);
    await i.reply(r.changes ? `✅ **${p.name}** removed from **${t.name}**.` : '❌ Player is not registered in this tournament.');
    return;
  }
  if (i.commandName === 'race') {
    const t = getTournament(i.options.getString('tournament', true));
    if (!t) { await i.reply('❌ Tournament not found.'); return; }
    const number = i.options.getInteger('number', true); const track = i.options.getString('track', true).trim();
    const parsed = parseResults(i.options.getString('results', true));
    if (!parsed) { await i.reply('❌ Invalid results. Use `Player1=25,Player2=18` or `1:Player1=25,2:Player2=18`.'); return; }
    try {
      const tx = db.transaction(() => {
        const race = db.prepare('INSERT INTO races(tournament_id,race_no,track) VALUES(?,?,?)').run(t.id,number,track);
        for (const e of parsed) {
          const p = ensurePlayer(e.name);
          addParticipant(t.id,p.id);
          db.prepare('INSERT INTO results(race_id,player_id,points,position) VALUES(?,?,?,?)').run(race.lastInsertRowid,p.id,e.points,e.position);
        }
      }); tx();
      await i.reply(`🏁 Race **${number}** recorded for **${t.name}** with **${parsed.length} players**.`);
    } catch (e:any) { await i.reply(`❌ Could not record race: ${e?.message || 'unknown error'}`); }
    return;
  }
  if (i.commandName === 'tournaments') {
    const gameName = i.options.getString('game');
    const rows = gameName ? db.prepare('SELECT t.name,g.name game_name,t.status FROM tournaments t JOIN games g ON g.id=t.game_id WHERE g.name=? COLLATE NOCASE ORDER BY t.created_at DESC').all(gameName) as any[] : db.prepare('SELECT t.name,g.name game_name,t.status FROM tournaments t LEFT JOIN games g ON g.id=t.game_id ORDER BY t.created_at DESC').all() as any[];
    const text = rows.length ? rows.map((r,n)=>`${n+1}. **${r.name}** — 🎮 ${r.game_name || 'General'} • ${r.status}`).join('\n') : 'No tournaments found.';
    await i.reply({embeds:[new EmbedBuilder().setTitle(gameName ? `🏆 ${gameName} Tournaments` : '🏆 All Tournaments').setDescription(clean(text))]}); return;
  }
  if (i.commandName === 'players') {
    const rows = db.prepare(`SELECT p.name,COUNT(DISTINCT r.id) races,COALESCE(SUM(r.points),0) points FROM players p LEFT JOIN results r ON r.player_id=p.id GROUP BY p.id ORDER BY points DESC,p.name`).all() as any[];
    const text = rows.length ? rows.map((r,n)=>`${n+1}. **${r.name}** — ${r.points} pts • ${r.races} races`).join('\n') : 'No players found.';
    await i.reply({embeds:[new EmbedBuilder().setTitle('👥 TGS Players').setDescription(clean(text))]}); return;
  }
  if (i.commandName === 'tournament-report') { await sendTournamentReport(i, i.options.getString('tournament', true)); return; }
  if (i.commandName === 'player-report' || i.commandName === 'player-history') {
    const name=i.options.getString('player',true); const game=i.options.getString('game'); const p=getPlayer(name);
    if(!p){await i.reply('❌ Player not found.');return;}
    const rows=db.prepare(`SELECT t.name tournament,g.name game_name,ra.race_no,ra.track,r.points,r.position FROM results r JOIN races ra ON ra.id=r.race_id JOIN tournaments t ON t.id=ra.tournament_id LEFT JOIN games g ON g.id=t.game_id WHERE r.player_id=? ${game?'AND g.name=? COLLATE NOCASE':''} ORDER BY ra.created_at DESC,ra.race_no DESC`).all(...(game?[p.id,game]:[p.id])) as any[];
    if(i.commandName==='player-history') { const text=rows.length?rows.map(r=>`🎮 **${r.game_name||'General'}** • **${r.tournament}** • Race ${r.race_no} • ${r.track} — **P${r.position??'-'} / ${r.points} pts**`).join('\n'):'No races recorded.'; await i.reply({embeds:[new EmbedBuilder().setTitle(`📋 ${p.name} History`).setDescription(clean(text))]}); return; }
    const total=rows.reduce((s,r)=>s+Number(r.points),0); const tournaments=new Set(rows.map(r=>r.tournament)).size; const wins=rows.filter(r=>Number(r.position)===1).length;
    const text=rows.length?rows.map(r=>`🎮 **${r.game_name||'General'}** • ${r.tournament} • Race ${r.race_no} — **P${r.position??'-'}**, ${r.points} pts`).join('\n'):'No records found.';
    await i.reply({embeds:[new EmbedBuilder().setTitle(`📊 ${p.name} Report`).setDescription(clean(`**Total Points:** ${total}\n**Tournaments:** ${tournaments}\n**Races:** ${rows.length}\n**Wins (P1):** ${wins}\n\n${text}`))]}); return;
  }
  if (i.commandName === 'game-report') {
    const game=getGame(i.options.getString('game',true)); if(!game){await i.reply('❌ Game not found.');return;}
    const ts=db.prepare(`SELECT t.name,COUNT(DISTINCT ra.id) races FROM tournaments t LEFT JOIN races ra ON ra.tournament_id=t.id WHERE t.game_id=? GROUP BY t.id ORDER BY t.created_at DESC`).all(game.id) as any[];
    const ps=db.prepare(`SELECT p.name,SUM(r.points) points,COUNT(r.id) races FROM results r JOIN players p ON p.id=r.player_id JOIN races ra ON ra.id=r.race_id JOIN tournaments t ON t.id=ra.tournament_id WHERE t.game_id=? GROUP BY p.id ORDER BY points DESC`).all(game.id) as any[];
    await i.reply({embeds:[new EmbedBuilder().setTitle(`🎮 ${game.name} Report`).setDescription(clean(`**Tournaments**\n${ts.length?ts.map((r,n)=>`${n+1}. **${r.name}** — ${r.races} races`).join('\n'):'None'}\n\n**Players**\n${ps.length?ps.map((r,n)=>`${n+1}. **${r.name}** — ${r.points} pts • ${r.races} races`).join('\n'):'None'}`))]}); return;
  }
}

async function sendTournamentReport(i: ChatInputCommandInteraction | ButtonInteraction, name: string) {
  const t=getTournament(name); if(!t){await i.reply({content:'❌ Tournament not found.',ephemeral:true});return;}
  const rows=db.prepare(`SELECT p.name,SUM(r.points) total,COUNT(r.id) races,MIN(r.position) best_position,AVG(r.position) avg_position FROM results r JOIN players p ON p.id=r.player_id JOIN races ra ON ra.id=r.race_id WHERE ra.tournament_id=? GROUP BY p.id ORDER BY total DESC,best_position ASC`).all(t.id) as any[];
  const races=db.prepare('SELECT race_no,track FROM races WHERE tournament_id=? ORDER BY race_no').all(t.id) as any[];
  const participants=db.prepare('SELECT p.name FROM tournament_players tp JOIN players p ON p.id=tp.player_id WHERE tp.tournament_id=? ORDER BY p.name').all(t.id) as any[];
  const standings=rows.length?rows.map((r,n)=>`${n+1}. **${r.name}** — **${r.total} pts** • ${r.races} races • Best P${r.best_position??'-'} • Avg P${Number(r.avg_position||0).toFixed(1)}`).join('\n'):'No results recorded.';
  const raceList=races.length?races.map(r=>`Race ${r.race_no} — ${r.track}`).join('\n'):'No races recorded.';
  const pList=participants.length?participants.map(r=>`• ${r.name}`).join('\n'):'No participants.';
  await i.reply({embeds:[new EmbedBuilder().setTitle(`🏆 ${t.name}`).setDescription(clean(`🎮 **Game:** ${t.game_name||'General'}\n📌 **Status:** ${t.status}\n\n**PARTICIPANTS**\n${pList}\n\n**STANDINGS**\n${standings}\n\n**RACES**\n${raceList}`))]});
}

async function handleSelect(i: StringSelectMenuInteraction) {
  if (i.customId !== 'tgs:tournament-select') return;
  const id=Number(i.values[0]); const t=getTournamentById(id);
  if(!t){await i.update({content:'❌ Tournament not found.',components:[]});return;}
  await i.update({content:`🏆 **${t.name}**\n🎮 Game: **${t.game_name||'General'}**\n📌 Status: **${t.status}**\n\nChoose an action:`,components:[managerButtons(id)]});
}

async function handleButton(i: ButtonInteraction) {
  const [prefix,action,idText]=i.customId.split(':'); if(prefix!=='tgs') return;
  const id=Number(idText); const t=getTournamentById(id); if(!t){await i.reply({content:'❌ Tournament not found.',ephemeral:true});return;}
  if(action==='report'){await sendTournamentReport(i,t.name);return;}
  if(action==='update'||action==='delete'||action==='fixtures'){await i.showModal(passwordModal(action,id));return;}
}

async function handleModal(i: ModalSubmitInteraction) {
  const parts=i.customId.split(':'); if(parts[0]!=='tgs'||parts[1]!=='password') return;
  const action=parts[2]; const id=Number(parts[3]); const t=await verifyTournamentAccess(i,action,id); if(!t)return;
  if(action==='delete') {
    db.prepare('DELETE FROM tournaments WHERE id=?').run(id);
    await i.reply({content:`🗑️ Tournament **${t.name}** and its linked tournament records have been deleted.`,ephemeral:true}); return;
  }
  if(action==='fixtures') {
    try { const r=createFixtures(id); await i.reply({content:`✅ Fixtures created for **${t.name}**.\n👥 Players: ${r.players}\n📐 Bracket size: ${r.size}\n🏁 First round: **${r.firstRound}**`,ephemeral:true}); }
    catch(e:any){await i.reply({content:`❌ ${e?.message||'Could not create fixtures.'}`,ephemeral:true});}
    return;
  }
  if(action==='update') {
    const modal=new ModalBuilder().setCustomId(`tgs:update-form:${id}`).setTitle('Update Tournament');
    const name=new TextInputBuilder().setCustomId('name').setLabel('Tournament name').setStyle(TextInputStyle.Short).setRequired(true).setValue(t.name);
    const game=new TextInputBuilder().setCustomId('game').setLabel('Game name').setStyle(TextInputStyle.Short).setRequired(true).setValue(t.game_name||'General');
    const status=new TextInputBuilder().setCustomId('status').setLabel('Status (draft/live/completed)').setStyle(TextInputStyle.Short).setRequired(true).setValue(t.status);
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(name),new ActionRowBuilder<TextInputBuilder>().addComponents(game),new ActionRowBuilder<TextInputBuilder>().addComponents(status));
    await i.showModal(modal); return;
  }
}

async function handleUpdateForm(i: ModalSubmitInteraction) {
  const id=Number(i.customId.split(':')[2]); const t=getTournamentById(id); if(!t){await i.reply({content:'❌ Tournament not found.',ephemeral:true});return;}
  // The password has already been verified immediately before opening this form. Keep this modal short-lived.
  const name=i.fields.getTextInputValue('name').trim(); const gameName=i.fields.getTextInputValue('game').trim(); const status=i.fields.getTextInputValue('status').trim().toLowerCase();
  if(!name||!gameName){await i.reply({content:'❌ Name and game are required.',ephemeral:true});return;}
  const game=getGame(gameName); if(!game){await i.reply({content:`❌ Game **${gameName}** does not exist.`,ephemeral:true});return;}
  if(!['draft','live','completed','fixtures_created'].includes(status)){await i.reply({content:'❌ Invalid status. Use draft, live, completed or fixtures_created.',ephemeral:true});return;}
  try { db.prepare('UPDATE tournaments SET name=?,game_id=?,status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(name,game.id,status,id); await i.reply({content:`✅ Tournament updated: **${name}** • 🎮 **${game.name}** • **${status}**`,ephemeral:true}); }
  catch { await i.reply({content:'❌ Could not update tournament. The name may already be in use.',ephemeral:true}); }
}

client.once('ready', async c => { console.log(`Logged in as ${c.user.tag}`); try { await registerCommands(); } catch(e) { console.error('Command registration failed:',e); } });
client.on('interactionCreate', async (i: Interaction) => {
  try {
    if(i.isChatInputCommand()) await handleCommand(i);
    else if(i.isStringSelectMenu()) await handleSelect(i);
    else if(i.isButton()) await handleButton(i);
    else if(i.isModalSubmit() && i.customId.startsWith('tgs:update-form:')) await handleUpdateForm(i);
    else if(i.isModalSubmit()) await handleModal(i);
  } catch(e:any) {
    console.error('Interaction error:',e);
    const message='❌ Something went wrong while processing this action.';
    if(i.isRepliable()) { if(i.replied||i.deferred) await i.followUp({content:message,ephemeral:true}).catch(()=>{}); else await i.reply({content:message,ephemeral:true}).catch(()=>{}); }
  }
});

client.login(token);
