const fs = require('node:fs');
const path = require('node:path');
const file = path.join(process.cwd(), 'src', 'index.ts');
let source = fs.readFileSync(file, 'utf8');

// /tournaments -> game autocomplete/dropdown.
source = source.replace(
  ".setName('tournaments').setDescription('List tournaments').addStringOption(o=>o.setName('game').setDescription('Optional game filter'))",
  ".setName('tournaments').setDescription('List tournaments').addStringOption(o=>o.setName('game').setDescription('Select a game').setAutocomplete(true))"
);

// Add autocomplete handling for /tournaments game.
if (!source.includes("i.commandName==='tournaments'")) {
  const marker = "if(i.isAutocomplete()){";
  const pos = source.indexOf(marker);
  if (pos === -1) throw new Error('Autocomplete handler not found.');
  const block = `if(i.commandName==='tournaments'){const focused=i.options.getFocused(true);if(focused.name==='game'){const query=String(focused.value??'').trim();const games=db.prepare("SELECT name FROM games WHERE name LIKE ? COLLATE NOCASE ORDER BY name ASC LIMIT 25").all(\`%\${query}%\`) as {name:string}[];await i.respond(games.map(g=>({name:g.name,value:g.name})));return;}}`;
  source = source.slice(0, pos + marker.length) + block + source.slice(pos + marker.length);
}

// /fixtures -> tournament autocomplete/dropdown.
source = source.replace(
  ".setName('fixtures').setDescription('Show tournament fixtures').addStringOption(o=>o.setName('tournament').setDescription('Tournament').setRequired(true))",
  ".setName('fixtures').setDescription('Show tournament fixtures').addStringOption(o=>o.setName('tournament').setDescription('Tournament').setRequired(true).setAutocomplete(true))"
);

if (!source.includes("i.commandName==='fixtures'")) {
  const marker = "if(i.isAutocomplete()){";
  const pos = source.indexOf(marker);
  if (pos === -1) throw new Error('Autocomplete handler not found.');
  const block = `if(i.commandName==='fixtures'){const focused=i.options.getFocused(true);if(focused.name==='tournament'){const query=String(focused.value??'').trim();const tournaments=db.prepare("SELECT t.id,t.name,g.name game_name,t.status FROM tournaments t LEFT JOIN games g ON g.id=t.game_id WHERE t.name LIKE ? COLLATE NOCASE ORDER BY t.created_at DESC LIMIT 25").all(\`%\${query}%\`) as {id:number,name:string,game_name:string|null,status:string}[];await i.respond(tournaments.map(t=>({name:\`\${t.name} • \${t.game_name||'General'} • \${t.status}\`.slice(0,100),value:t.name})));return;}}`;
  source = source.slice(0, pos + marker.length) + block + source.slice(pos + marker.length);
}

fs.writeFileSync(file, source);
console.log('Game/tournament dropdown migration applied.');
