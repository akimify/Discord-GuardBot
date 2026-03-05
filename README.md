# Discord-GuardBot

A Discord auto-moderation bot with a web management panel.

---

## Features

- Banned word detection & auto-delete
- Anti-spam (rate limiting)
- Duplicate message filtering
- Discord invite link blocking
- Mention & emoji spam limits
- Warning system with auto-timeout
- Web panel for configuration

---

## Quick Start

```bash
git clone https://github.com/yourusername/discord-guard.git
cd discord-guard
npm install
node index.js
```

Open the panel at `http://localhost:3000`, log in with the password printed in the console, paste your Bot Token, and start the bot.

---

## Bot Commands

| Command | Description |
|---|---|
| `!warn @user <reason>` | Warn a user |
| `!unwarn @user` | Clear warnings |
| `!warnings @user` | Check warning count |
| `!help` | Show commands |

---

## Configuration

All settings are saved to `.npm/sub.txt` and can be managed from the web panel.

Key fields:

```
bannedWords       comma-separated list of blocked words
blockInvites      remove discord invite links (true/false)
blockLinks        remove all URLs (true/false)
antiSpam          rate-limit messages (true/false)
antiDuplicate     delete repeated messages (true/false)
maxMentions       max @mentions per message (0 = off)
maxEmojis         max emojis per message (0 = off)
maxWarnings       warnings before timeout
timeoutDuration   timeout length in minutes
logChannelId      channel ID for mod logs
ignoredRoles      role IDs that bypass all rules
ignoredChannels   channel IDs to skip
```

---

## Bot Setup

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create an app → Bot → copy Token
3. Enable **Message Content Intent** and **Server Members Intent**
4. Invite the bot with `Manage Messages` + `Moderate Members` permissions

---

## API Endpoints

```
GET  /api/auth/check
POST /api/auth/login
POST /api/auth/logout
POST /api/auth/change-password
GET  /api/config
POST /api/config
POST /api/bot/start
POST /api/bot/stop
GET  /api/warnings/:guildId
```

---

## Requirements

- Node.js >= 16.9.0

## License

MIT
