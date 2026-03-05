const { Client, GatewayIntentBits, PermissionsBitField, EmbedBuilder } = require('discord.js');
const fs   = require('fs');
const path = require('path');
const express    = require('express');
const bodyParser = require('body-parser');
const session    = require('express-session');
const axios      = require('axios');

// ─────────────────────────────────────────────
//  App bootstrap
// ─────────────────────────────────────────────
const app  = express();
const PORT = process.env.SERVER_PORT || process.env.PORT || process.env.APP_PORT || 3000;
const DATA_FILE = './.npm/sub.txt';

// ─────────────────────────────────────────────
//  Auto-detect public IP
// ─────────────────────────────────────────────
async function resolvePublicIP() {
  const providers = ['https://api.ipify.org', 'https://api.ip.sb/ip'];
  for (const url of providers) {
    try {
      const { data } = await axios.get(url, { timeout: 3000 });
      return data.trim();
    } catch (_) { /* try next */ }
  }
  return null;
}

// ─────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────
function randomStr(len = 16) {
  const pool = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: len }, () => pool[Math.floor(Math.random() * pool.length)]).join('');
}

// ─────────────────────────────────────────────
//  Default settings
// ─────────────────────────────────────────────
let settings = {
  adminPassword : randomStr(16),
  discordToken  : '',
  prefix        : '!',
  botStatus     : 'offline',

  // Moderation rules
  rules: {
    bannedWords      : ['badword1', 'badword2'],   // customizable list
    blockLinks       : false,                       // delete all http/https links
    blockInvites     : true,                        // delete discord invite links
    antiSpam         : true,                        // rate-limit messages
    antiDuplicate    : true,                        // delete repeated identical messages
    maxMentions      : 5,                           // max @mentions per message (0 = off)
    maxEmojis        : 15,                          // max emojis per message (0 = off)
    maxWarnings      : 3,                           // auto-timeout after N warnings
    timeoutDuration  : 10,                          // minutes to timeout
    logChannelId     : '',                          // channel id for mod logs
    ignoredRoles     : [],                          // role ids that bypass rules
    ignoredChannels  : [],                          // channel ids to skip
  }
};

// ─────────────────────────────────────────────
//  Persistence
// ─────────────────────────────────────────────
function loadSettings() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const lines = fs.readFileSync(DATA_FILE, 'utf8').split('\n');
      lines.forEach(line => {
        const eqIdx = line.indexOf('=');
        if (eqIdx === -1) return;
        const key = line.slice(0, eqIdx).trim();
        const val = line.slice(eqIdx + 1).trim();
        // Top-level scalar fields
        if (['adminPassword', 'discordToken', 'prefix', 'botStatus'].includes(key)) {
          settings[key] = val;
        }
        // Rule fields that are booleans
        else if (['blockLinks', 'blockInvites', 'antiSpam', 'antiDuplicate'].includes(key)) {
          settings.rules[key] = val === 'true';
        }
        // Rule fields that are numbers
        else if (['maxMentions', 'maxEmojis', 'maxWarnings', 'timeoutDuration'].includes(key)) {
          settings.rules[key] = parseInt(val) || 0;
        }
        // Rule fields that are strings
        else if (key === 'logChannelId') {
          settings.rules.logChannelId = val;
        }
        // Rule fields that are comma-separated arrays
        else if (key === 'bannedWords') {
          settings.rules.bannedWords = val ? val.split(',').map(w => w.trim()).filter(Boolean) : [];
        }
        else if (key === 'ignoredRoles') {
          settings.rules.ignoredRoles = val ? val.split(',').map(r => r.trim()).filter(Boolean) : [];
        }
        else if (key === 'ignoredChannels') {
          settings.rules.ignoredChannels = val ? val.split(',').map(c => c.trim()).filter(Boolean) : [];
        }
      });
      console.log('✅ Settings loaded');
    } else {
      console.log('📝 First run — generating new config');
      console.log('🔑 Admin password:', settings.adminPassword);
      persistSettings();
    }
  } catch (e) {
    console.error('❌ Failed to load settings:', e.message);
  }
}

function persistSettings() {
  try {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const r = settings.rules;
    const lines = [
      `adminPassword=${settings.adminPassword}`,
      `discordToken=${settings.discordToken}`,
      `prefix=${settings.prefix}`,
      `botStatus=${settings.botStatus}`,
      `bannedWords=${r.bannedWords.join(',')}`,
      `blockLinks=${r.blockLinks}`,
      `blockInvites=${r.blockInvites}`,
      `antiSpam=${r.antiSpam}`,
      `antiDuplicate=${r.antiDuplicate}`,
      `maxMentions=${r.maxMentions}`,
      `maxEmojis=${r.maxEmojis}`,
      `maxWarnings=${r.maxWarnings}`,
      `timeoutDuration=${r.timeoutDuration}`,
      `logChannelId=${r.logChannelId}`,
      `ignoredRoles=${r.ignoredRoles.join(',')}`,
      `ignoredChannels=${r.ignoredChannels.join(',')}`,
    ];
    fs.writeFileSync(DATA_FILE, lines.join('\n'), 'utf8');
    console.log('💾 Settings saved');
  } catch (e) {
    console.error('❌ Failed to save settings:', e.message);
  }
}

loadSettings();

// ─────────────────────────────────────────────
//  In-memory state (resets on restart)
// ─────────────────────────────────────────────
// warnings[guildId][userId] = count
const warnings = {};
// spamTracker[userId] = { timestamps: [], lastMessage: '' }
const spamTracker = {};

function getWarnings(guildId, userId) {
  warnings[guildId] = warnings[guildId] || {};
  warnings[guildId][userId] = warnings[guildId][userId] || 0;
  return warnings[guildId][userId];
}

function addWarning(guildId, userId) {
  warnings[guildId] = warnings[guildId] || {};
  warnings[guildId][userId] = (warnings[guildId][userId] || 0) + 1;
  return warnings[guildId][userId];
}

function clearWarnings(guildId, userId) {
  if (warnings[guildId]) warnings[guildId][userId] = 0;
}

// ─────────────────────────────────────────────
//  Detection helpers
// ─────────────────────────────────────────────
const INVITE_RE = /discord(?:\.gg|\.com\/invite)\/[a-zA-Z0-9-]+/i;
const LINK_RE   = /https?:\/\/\S+/i;

function containsBannedWord(text) {
  const lower = text.toLowerCase();
  return settings.rules.bannedWords.find(w => lower.includes(w.toLowerCase())) || null;
}

function isRateLimited(userId) {
  const now   = Date.now();
  const track = spamTracker[userId] || { timestamps: [], lastMessage: '' };
  // Keep only messages from the last 5 seconds
  track.timestamps = track.timestamps.filter(t => now - t < 5000);
  track.timestamps.push(now);
  spamTracker[userId] = track;
  return track.timestamps.length > 5; // more than 5 messages in 5 s
}

function isDuplicate(userId, content) {
  const track = spamTracker[userId] || { timestamps: [], lastMessage: '' };
  const dup   = track.lastMessage === content;
  track.lastMessage = content;
  spamTracker[userId] = track;
  return dup;
}

function countEmojis(text) {
  const emojiRe = /(\p{Emoji_Presentation}|\p{Extended_Pictographic}|<a?:\w+:\d+>)/gu;
  return (text.match(emojiRe) || []).length;
}

// ─────────────────────────────────────────────
//  Moderation action
// ─────────────────────────────────────────────
async function punish(message, reason) {
  const { guild, author, channel } = message;
  if (!guild) return;

  try { await message.delete(); } catch (_) { /* missing perms — skip */ }

  const count = addWarning(guild.id, author.id);
  const rules = settings.rules;

  // DM the user
  try {
    await author.send(`⚠️ **[${guild.name}]** Your message was removed.\n**Reason:** ${reason}\n**Warnings:** ${count}/${rules.maxWarnings}`);
  } catch (_) { /* DMs closed */ }

  // Timeout if threshold reached
  if (count >= rules.maxWarnings) {
    try {
      const member = await guild.members.fetch(author.id);
      if (member.moderatable) {
        await member.timeout(rules.timeoutDuration * 60 * 1000, `Reached ${count} warnings`);
        clearWarnings(guild.id, author.id);

        channel.send({
          embeds: [new EmbedBuilder()
            .setColor(0xFF0000)
            .setTitle('🔇 User Timed Out')
            .addFields(
              { name: 'User',     value: `${author.tag}`, inline: true },
              { name: 'Duration', value: `${rules.timeoutDuration} min`, inline: true },
              { name: 'Reason',   value: reason }
            )
            .setTimestamp()]
        });
      }
    } catch (e) {
      console.error('Timeout failed:', e.message);
    }
  }

  // Post to log channel
  if (rules.logChannelId) {
    try {
      const logCh = await guild.channels.fetch(rules.logChannelId);
      if (logCh) {
        logCh.send({
          embeds: [new EmbedBuilder()
            .setColor(0xFFA500)
            .setTitle('🛡️ Moderation Log')
            .addFields(
              { name: 'User',     value: `${author.tag} (${author.id})`, inline: true },
              { name: 'Channel',  value: `<#${channel.id}>`, inline: true },
              { name: 'Reason',   value: reason },
              { name: 'Warnings', value: `${count}/${rules.maxWarnings}` }
            )
            .setTimestamp()]
        });
      }
    } catch (_) { /* log channel not found */ }
  }
}

// ─────────────────────────────────────────────
//  Discord bot
// ─────────────────────────────────────────────
let discordClient = null;

function launchBot() {
  if (!settings.discordToken) {
    console.log('⚠️  No Discord Token set');
    return false;
  }

  try {
    discordClient = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.MessageContent,
      ]
    });

    // ── Ready ──────────────────────────────────
    discordClient.once('ready', () => {
      console.log(`✅ Logged in as ${discordClient.user.tag}`);
      settings.botStatus = 'online';
      persistSettings();
    });

    // ── Message handler ────────────────────────
    discordClient.on('messageCreate', async (msg) => {
      if (msg.author.bot || !msg.guild) return;

      const rules  = settings.rules;
      const prefix = settings.prefix;

      // ── Skip ignored channels / roles ────────
      if (rules.ignoredChannels.includes(msg.channel.id)) return;
      const member = await msg.guild.members.fetch(msg.author.id).catch(() => null);
      if (member && rules.ignoredRoles.some(r => member.roles.cache.has(r))) return;

      const content = msg.content;

      // ── Admin commands ────────────────────────
      if (content.startsWith(prefix)) {
        const [cmd, ...args] = content.slice(prefix.length).trim().split(/\s+/);

        if (cmd === 'warn' && args.length >= 2) {
          if (!member?.permissions.has(PermissionsBitField.Flags.ModerateMembers)) return;
          const target = msg.mentions.users.first();
          if (!target) return msg.reply('❌ Mention a user to warn.');
          const reason = args.slice(1).join(' ') || 'No reason provided';
          const count  = addWarning(msg.guild.id, target.id);
          return msg.reply(`⚠️ **${target.tag}** warned (${count}/${rules.maxWarnings}). Reason: ${reason}`);
        }

        if (cmd === 'unwarn' && args.length >= 1) {
          if (!member?.permissions.has(PermissionsBitField.Flags.ModerateMembers)) return;
          const target = msg.mentions.users.first();
          if (!target) return msg.reply('❌ Mention a user.');
          clearWarnings(msg.guild.id, target.id);
          return msg.reply(`✅ Warnings cleared for **${target.tag}**`);
        }

        if (cmd === 'warnings' && args.length >= 1) {
          const target = msg.mentions.users.first();
          if (!target) return msg.reply('❌ Mention a user.');
          const count  = getWarnings(msg.guild.id, target.id);
          return msg.reply(`📋 **${target.tag}** has **${count}** warning(s).`);
        }

        if (cmd === 'help') {
          return msg.reply({
            embeds: [new EmbedBuilder()
              .setColor(0x5865F2)
              .setTitle('🛡️ Moderation Bot — Commands')
              .addFields(
                { name: `${prefix}warn @user <reason>`,    value: 'Warn a user' },
                { name: `${prefix}unwarn @user`,           value: 'Clear all warnings for a user' },
                { name: `${prefix}warnings @user`,         value: 'Check warning count' },
                { name: `${prefix}help`,                   value: 'Show this message' }
              )
              .setFooter({ text: 'Configure rules in the web panel' })]
          });
        }

        return; // Unknown command — ignore
      }

      // ── Auto-mod checks ───────────────────────

      // 1. Banned words
      const found = containsBannedWord(content);
      if (found) return punish(msg, `Banned word detected: "${found}"`);

      // 2. Discord invites
      if (rules.blockInvites && INVITE_RE.test(content))
        return punish(msg, 'Discord invite link not allowed');

      // 3. All links
      if (rules.blockLinks && LINK_RE.test(content))
        return punish(msg, 'Links are not allowed in this server');

      // 4. Mention spam
      if (rules.maxMentions > 0 && msg.mentions.users.size > rules.maxMentions)
        return punish(msg, `Too many mentions (${msg.mentions.users.size})`);

      // 5. Emoji spam
      if (rules.maxEmojis > 0 && countEmojis(content) > rules.maxEmojis)
        return punish(msg, `Too many emojis (${countEmojis(content)})`);

      // 6. Duplicate messages
      if (rules.antiDuplicate && isDuplicate(msg.author.id, content))
        return punish(msg, 'Duplicate message (spam)');

      // 7. Rate limiting
      if (rules.antiSpam && isRateLimited(msg.author.id))
        return punish(msg, 'Sending messages too fast (spam)');
    });

    discordClient.login(settings.discordToken);
    return true;

  } catch (e) {
    console.error('❌ Bot start error:', e.message);
    settings.botStatus = 'error';
    return false;
  }
}

function shutdownBot() {
  if (discordClient) {
    discordClient.destroy();
    discordClient = null;
    settings.botStatus = 'offline';
    persistSettings();
    console.log('🛑 Bot stopped');
  }
}

// ─────────────────────────────────────────────
//  Express middleware
// ─────────────────────────────────────────────
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({
  secret: randomStr(32),
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 3_600_000 }
}));
app.use(express.static(__dirname));

// ─────────────────────────────────────────────
//  Auth routes
// ─────────────────────────────────────────────
app.get('/api/auth/check',   (req, res) => res.json({ isAdmin: !!req.session.isAdmin }));

app.post('/api/auth/login',  (req, res) => {
  if (req.body.password === settings.adminPassword) {
    req.session.isAdmin = true;
    return res.json({ success: true });
  }
  res.json({ success: false });
});

app.post('/api/auth/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });

app.post('/api/auth/change-password', (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ success: false });
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) return res.json({ success: false });
  settings.adminPassword = newPassword;
  persistSettings();
  req.session.destroy();
  res.json({ success: true });
});

// ─────────────────────────────────────────────
//  Config routes
// ─────────────────────────────────────────────
app.get('/api/config', (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ success: false });
  res.json(settings);
});

app.post('/api/config', (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ success: false });

  const { discordToken, prefix, rules } = req.body;

  settings.discordToken = discordToken  || settings.discordToken;
  settings.prefix       = prefix        || settings.prefix;

  if (rules) {
    // bannedWords may come as comma-separated string or array
    if (typeof rules.bannedWords === 'string') {
      rules.bannedWords = rules.bannedWords.split(',').map(w => w.trim()).filter(Boolean);
    }
    settings.rules = { ...settings.rules, ...rules };
  }

  persistSettings();
  res.json({ success: true });
});

// ─────────────────────────────────────────────
//  Bot control routes
// ─────────────────────────────────────────────
app.post('/api/bot/start', (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ success: false });
  const ok = launchBot();
  res.json({ success: ok, message: ok ? undefined : 'Token not configured' });
});

app.post('/api/bot/stop', (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ success: false });
  shutdownBot();
  res.json({ success: true });
});

// Expose live warning counts (read-only)
app.get('/api/warnings/:guildId', (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ success: false });
  res.json(warnings[req.params.guildId] || {});
});

// Main panel page
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'panel.html')));

// ─────────────────────────────────────────────
//  Start server
// ─────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', async () => {
  const ip = await resolvePublicIP();
  const host = ip || 'localhost';

  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║      🛡️  Discord Moderation Bot  —  Panel Ready      ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`🌐  Public  : http://${host}:${PORT}`);
  console.log(`🌐  Local   : http://localhost:${PORT}`);
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`🔐  Admin password : ${settings.adminPassword}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  console.log('💡  Tips:');
  console.log('    1. Log in with the password above');
  console.log('    2. Paste your Discord Bot Token in the panel');
  console.log('    3. Customise banned words and rules, then start the bot');
  console.log('    4. Config is stored in .npm/modbot.json');
  console.log('');

  // Auto-start if token looks valid and bot was previously online
  if (settings.discordToken.length > 50 && settings.botStatus === 'online') {
    console.log('🚀 Auto-starting bot with saved token...');
    launchBot();
  }
});
