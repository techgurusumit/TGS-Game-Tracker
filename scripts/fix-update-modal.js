const fs = require('node:fs');
const path = require('node:path');

const file = path.join(__dirname, '..', 'src', 'index.ts');
let source = fs.readFileSync(file, 'utf8');

const oldButton = "if(['update','delete','fixtures'].includes(action)){await i.showModal(passwordModal(action,id));return;}";
const newButton = "if(action==='update'){await i.showModal(updateModal(t));return;}if(['delete','fixtures'].includes(action)){await i.showModal(passwordModal(action,id));return;}";

if (source.includes(oldButton)) {
  source = source.replace(oldButton, newButton);
}

const oldPasswordUpdate = `  const modal=new ModalBuilder().setCustomId(\`tgs:update-form:\${id}\`).setTitle('Update Tournament');
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('password').setLabel('Tournament password').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(4)),
    new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('name').setLabel('Tournament name').setStyle(TextInputStyle.Short).setRequired(true).setValue(t.name)),
    new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('game').setLabel('Game name').setStyle(TextInputStyle.Short).setRequired(true).setValue(t.game_name||'General')),
    new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('status').setLabel('Status: draft/live/completed').setStyle(TextInputStyle.Short).setRequired(true).setValue(t.status)),
  );
  await i.showModal(modal);`;

const newPasswordUpdate = `  const name=i.fields.getTextInputValue('name').trim(),gameName=i.fields.getTextInputValue('game').trim(),status=i.fields.getTextInputValue('status').trim().toLowerCase();
  const g=getGame(gameName);
  if(!g){await i.reply({content:\`❌ Game **\${gameName}** not found.\`,ephemeral:true});return;}
  if(!['draft','live','completed','fixtures_created'].includes(status)){await i.reply({content:'❌ Invalid status.',ephemeral:true});return;}
  if(!name){await i.reply({content:'❌ Tournament name cannot be empty.',ephemeral:true});return;}
  try{db.prepare('UPDATE tournaments SET name=?,game_id=?,status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(name,g.id,status,id);await i.reply({content:\`✅ Tournament updated to **\${name}** • 🎮 \${g.name} • \${status}\`,ephemeral:true});}
  catch{await i.reply({content:'❌ Could not update tournament. The name may already exist.',ephemeral:true});}`;

if (source.includes(oldPasswordUpdate)) {
  source = source.replace(oldPasswordUpdate, newPasswordUpdate);
}

const marker = "function passwordModal(action:string,id:number){";
if (!source.includes('function updateModal(t:any)')) {
  const insertAt = source.indexOf('\n', source.indexOf(marker));
  const end = source.indexOf('\nasync function passwordOk', insertAt);
  const updateModal = `\nfunction updateModal(t:any){const m=new ModalBuilder().setCustomId(\`tgs:password:update:\${t.id}\`).setTitle('Update Tournament');m.addComponents(\n  new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('password').setLabel('Tournament password').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(4)),\n  new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('name').setLabel('Tournament name').setStyle(TextInputStyle.Short).setRequired(true).setValue(t.name)),\n  new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('game').setLabel('Game name').setStyle(TextInputStyle.Short).setRequired(true).setValue(t.game_name||'General')),\n  new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('status').setLabel('Status: draft/live/completed').setStyle(TextInputStyle.Short).setRequired(true).setValue(t.status)),\n);return m;}\n`;
  if (end !== -1) source = source.slice(0, end) + updateModal + source.slice(end);
}

fs.writeFileSync(file, source);
console.log('Tournament update modal patch applied (or already present).');
