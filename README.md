# imood-tg-bot-template

(I asked claude to sum up for me. I've already had it proofread and did some edits, so there shouldn't be any problems)

It's a telegram bot that lets you log your mood to [imood.com](https://www.imood.com), check your mood history, your buddies' moods, and more — all from a telegram chat.

I wrote an article about this tool, you may check that for some detailed info:
http://h80h.xyz/blog/code/imood-time-telegram-bot/

## Repo structure

```
.
├── api/
│   ├── webhook.js       # the bot: telegram webhook + cron trigger + status proxy
│   └── moods.js          # VALID_MOODS — imood's official mood list
├── public/
│   ├── faces-grid.png    # reference image sent by /faces
│   └── moods-zh-tw.txt   # translated mood list sent by /translation
├── .env.local             # environment variable template (see below)
└── package.json
```

Everything needed to run the bot is already in the repo — you only need to supply your own accounts and secrets.

## Features

| Command | What it does |
|---|---|
| `/start` | Shows the command list and update format |
| `/faces` | Sends the reference image for face ids (0–32) |
| `/moods` | Links the official imood mood list |
| `/buddies` | Shows the current moods of your imood buddies |
| `/history` | Shows your last 16 imood log entries | 
| `/translation` | Sends a link to the translated mood list |

To log a mood, just message the bot in this format:

```
<mood> <mood details> <#face id>
```
(separate each two parameter with a space)

Example:

```
calm i can now easily develop my imood habit #5
```

There's also an optional public JSON endpoint (`?action=status`) that returns your current mood, so you can display it on your own website.

## How it works

`api/webhook.js` is a single serverless function with three routes:

1. **telegram webhook** (`POST`) — receives your messages and calls imood.org's XML API to read/update your mood.
2. **Cron trigger** (`GET ?secret=...`) — call this from a scheduler to send yourself a "log your mood" reminder.
3. **Status proxy** (`GET ?action=status`) — returns your current mood as public JSON.

It's written for Vercel (functions under `/api`, static files under `/public`), but the handler itself has no platform-specific code beyond the `(req, res)` signature.

## Prerequisites

- An [imood](https://www.imood.com) account (email, password, and username)
- A **telegram bot** — create one with [@BotFather](https://t.me/BotFather) and grab the bot token
- Your own **telegram numeric chat ID** (message [@userinfobot](https://t.me/userinfobot) to get it)
- A [Vercel](https://vercel.com) account (or similar Node 18+ serverless host)
- A [cron-job.org](https://cron-job.org) account (they provide low-latency service)

## Setup

### 1. Fork/clone the repo

`package.json` has no dependencies to install — the bot only uses Node's built-in `fetch`.

### 2. Fill in your environment variables

Don't forget to put `.env.local` into the list of .gitignore if you're gonna edit your repo and commit later. (never commit secrets)

You need to set these environment variables in your Vercel project's environment variable settings for production

| Variable | Description |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Token from @BotFather |
| `TELEGRAM_CHAT_ID` | Your personal telegram chat ID — the bot ignores everyone else |
| `TELEGRAM_SECRET_TOKEN` | A random string you invent; verifies webhook calls really come from telegram |
| `IMOOD_EMAIL` | Your imood.com account email |
| `IMOOD_PASSWORD` | Your imood.com account password |
| `IMOOD_USERNAME` | Your imood.com username (used to build your profile link) |
| `CRON_SECRET` | A random string you invent; required to trigger the reminder route |
| `ALLOWED_ORIGIN` | *(Optional)* the site domain allowed to call the public status endpoint from a browser, e.g. `https://your-site.com` |

Generate the two random secrets from a terminal, e.g. `openssl rand -hex 32` on linux or mac.

### 4. (Optional) Daily reminder

Point any scheduler at:

```
GET https://<your-deployment-domain>/api/webhook?secret=<CRON_SECRET>
```
If you want to use cron-job.org, paste the url (parameter replaced) above into the URL input in COMMON tab, and make sure the request method is GET in ADVANCED tab. 

Don't forget to choose your preferred schedule and timezone.

### 5. (Optional) Public status endpoint

`GET /api/webhook?action=status` returns your current mood as JSON:

```json
{ "base": "calm", "personal": "shipping a side project" }
```

This is unauthenticated by design — it only exposes your current public mood, the same thing imood already shows on your profile page. `ALLOWED_ORIGIN` just controls which website's front-end JavaScript is allowed to read the response in a browser (standard CORS); it doesn't restrict who can request the data directly. Leave it blank if you don't plan to embed this anywhere.

### 6. Deploy

```bash
vercel deploy
```

(or connect the repo in the Vercel dashboard for git-based deploys)

### 7. Register the telegram webhook

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -d "url=https://<your-deployment-domain>/api/webhook" \
  -d "secret_token=<TELEGRAM_SECRET_TOKEN>"
```

Message your bot `/start` to confirm it responds.

## Security notes

- The bot only responds to the chat ID in `TELEGRAM_CHAT_ID` — anyone else who messages it is silently ignored.
- `TELEGRAM_SECRET_TOKEN` stops randoms from POSTing fake "messages" directly to your webhook URL.
- Your imood email/password live only in environment variables on your own deployment — never commit real values to `.env.local`.