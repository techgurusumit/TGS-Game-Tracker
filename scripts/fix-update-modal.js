const fs = require('node:fs');
const path = require('node:path');
const file = path.join(process.cwd(), 'src', 'index.ts');
let source = fs.readFileSync(file, 'utf8');

// Update button must open ONE modal containing password + editable fields.
source = source.replace(
  "if(['update','delete','fixtures'].includes(action)){await i.showModal(passwordModal(action,id));return;}",
  "if(action==='update'){await i.showModal(updateModal(t));return;}if(['delete','fixtures'].includes(action)){await i.showModal(passwordModal(action,id));return;}"
);

// Replace the entire password-modal handler with a version that never calls showModal()
// on a ModalSubmitInteraction.
const start = source.indexOf('async function handlePasswordModal(i:ModalSubmitInteraction)');
const end = source.indexOf('\nasync function handleUpdateForm', start);
if (start === -1 || end === -1) throw new Error('Could not locate tournament modal handlers.');

const newPasswordHandler = `async function handlePasswordModal(i:ModalSubmitInteraction){const parts=i.customId.split(':');const action=parts[2],id=Number(parts[3]);const t=await passwordOk(i,id);if(!t)return;
  if(action==='delete'){db.prepare('DELETE FROM tournaments WHERE id=?').run(id);await i.reply({content:\`🗑️ Tournament **\${t.name}** deleted.\`,ephemeral:true});return;}
  if(action==='fixtures'){try{const r=createFixtures(id);await i.reply({content:\`✅ Fixtures created for **\${t.name}**.\\n👥 Players: \${r.players}\\n📐 Bracket size: \${r.size}\\n\\nUse /fixtures to view them.\`,ephemeral:true});}catch(e:any){await i.reply({content:\`❌ \${e?.message||'Could not create fixtures.'}\`,ephemeral:true});}return;}
}
`;
source = source.slice(0, start) + newPasswordHandler + source.slice(end);

// Add the combined update modal before the password handler.
if (!source.includes('function updateModal(t:any)')) {
  const marker = 'async function handlePasswordModal(i:ModalSubmitInteraction)';
  const pos = source.indexOf(marker);
  const modal = `function updateModal(t:any){const m=new ModalBuilder().setCustomId(\`tgs:update-form:\${t.id}\`).setTitle('Update Tournament');m.addComponents(
  new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('password').setLabel('Tournament password').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(4)),
  new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('name').setLabel('Tournament name').setStyle(TextInputStyle.Short).setRequired(true).setValue(t.name)),
  new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('game').setLabel('Game name').setStyle(TextInputStyle.Short).setRequired(true).setValue(t.game_name||'General')),
  new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('status').setLabel('Status: draft/live/completed').setStyle(TextInputStyle.Short).setRequired(true).setValue(t.status)),
);return m;}
`;
  source = source.slice(0, pos) + modal + source.slice(pos);
}

// Replace the update-form handler with direct validation/update. It receives one modal submission.
const ustart = source.indexOf('async function handleUpdateForm(i:ModalSubmitInteraction)');
const uend = source.indexOf('\nfunction birthdayDateIndia', ustart);
if (ustart !== -1 && uend !== -1) {
  const newUpdateHandler = `async function handleUpdateForm(i:ModalSubmitInteraction){const id=Number(i.customId.split(':')[2]),t=getTournamentById(id);if(!t){await i.reply({content:'❌ Tournament not found.',ephemeral:true});return;}const p=i.fields.getTextInputValue('password');if(!t.password_hash||!t.password_salt||!verifyPassword(p,t.password_hash,t.password_salt)){await i.reply({content:'❌ Incorrect tournament password.',ephemeral:true});return;}const name=i.fields.getTextInputValue('name').trim(),gameName=i.fields.getTextInputValue('game').trim(),status=i.fields.getTextInputValue('status').trim().toLowerCase();const g=getGame(gameName);if(!g){await i.reply({content:\`❌ Game **\${gameName}** not found.\`,ephemeral:true});return;}if(!['draft','live','completed','fixtures_created'].includes(status)){await i.reply({content:'❌ Invalid status.',ephemeral:true});return;}if(!name){await i.reply({content:'❌ Tournament name cannot be empty.',ephemeral:true});return;}try{db.prepare('UPDATE tournaments SET name=?,game_id=?,status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(name,g.id,status,id);await i.reply({content:\`✅ Tournament updated to **\${name}\` • 🎮 \${g.name} • \${status}\`,ephemeral:true});}catch{await i.reply({content:'❌ Could not update tournament. The name may already exist.',ephemeral:true});}}
`;
  source = source.slice(0, ustart) + newUpdateHandler + source.slice(uend);
}

// /tournaments -> game autocomplete/dropdown.
source = source.replace(
  ".setName('tournaments').setDescription('List tournaments').addStringOption(o=>o.setName('game').setDescription('Optional game filter'))",
  ".setName('tournaments').setDescription('List tournaments').addStringOption(o=>o.setName('game').setDescription('Select a game').setAutocomplete(true))"
);

// /fixtures -> tournament autocomplete/dropdown.
source = source.replace(
  ".setName('fixtures').setDescription('Show tournament fixtures').addStringOption(o=>o.setName('tournament').setDescription('Tournament').setRequired(true))",
  ".setName('fixtures').setDescription('Show tournament fixtures').addStringOption(o=>o.setName('tournament').setDescription('Tournament').setRequired(true).setAutocomplete(true))"
);

// Add autocomplete support once, without duplicating an existing handler.
const autoMarker = "if(i.isAutocomplete()){";
const autoPos = source.indexOf(autoMarker);
if (autoPos === -1) throw new Error('Autocomplete handler not found.');

if (!source.includes("i.commandName==='tournaments'")) {
  const block = `if(i.commandName==='tournaments'){const focused=i.options.getFocused(true);if(focused.name==='game'){const query=String(focused.value??'').trim();const games=db.prepare("SELECT name FROM games WHERE name LIKE ? COLLATE NOCASE ORDER BY name ASC LIMIT 25").all(\`%\${query}%\`) as {name:string}[];await i.respond(games.map(g=>({name:g.name,value:g.name})));return;}}`;
  source = source.slice(0, autoPos + autoMarker.length) + block + source.slice(autoPos + autoMarker.length);
}

if (!source.includes("i.commandName==='fixtures'")) {
  const pos2 = source.indexOf(autoMarker);
  const block = `if(i.commandName==='fixtures'){const focused=i.options.getFocused(true);if(focused.name==='tournament'){const query=String(focused.value??'').trim();const tournaments=db.prepare("SELECT t.id,t.name,g.name game_name,t.status FROM tournaments t LEFT JOIN games g ON g.id=t.game_id WHERE t.name LIKE ? COLLATE NOCASE ORDER BY t.created_at DESC LIMIT 25").all(\`%\${query}%\`) as {id:number,name:string,game_name:string|null,status:string}[];await i.respond(tournaments.map(t=>({name:\`\${t.name} • \${t.game_name||'General'} • \${t.status}\`.slice(0,100),value:t.name})));return;}}`;
  source = source.slice(0, pos2 + autoMarker.length) + block + source.slice(pos2 + autoMarker.length);
}

// Excel report compatibility: older SQLite databases may not have these columns.
// Add them idempotently before the Excel queries use them.
const migrationMarker = "console.log('Tournament update + game/fixture dropdown migration applied.');";
if (!source.includes("ALTER TABLE tournament_players ADD COLUMN joined_at")) {
  const migration = `try{db.prepare("ALTER TABLE tournament_players ADD COLUMN joined_at TEXT DEFAULT CURRENT_TIMESTAMP").run();}catch(_){}\ntry{db.prepare("ALTER TABLE matches ADD COLUMN updated_at TEXT DEFAULT CURRENT_TIMESTAMP").run();}catch(_){}\n`;
  source = source.replace(migrationMarker, migration + migrationMarker);
}

fs.writeFileSync(file, source);
console.log('Tournament update + game/fixture dropdown + Excel database migration applied.');
