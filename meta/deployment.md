# Deployment & Operations

One Cloudflare Worker does everything: it serves the browser client from `web/`,
guards `/api/*` with the game password, reads live state from this repo, and calls Mistral.
One deploy, one URL.

## What you need

| Thing | Where it comes from |
|---|---|
| Cloudflare account | already created |
| Node.js 18+ | to run `wrangler` |
| Game password | you choose it; this is what players type at the gate |
| Mistral API key | console.mistral.ai → API Keys |
| GitHub token (read-only) | see below |

### Making the GitHub token

GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token.

- **Repository access:** Only select repositories → `TheG3ISTY/eidholm`
- **Permissions → Repository permissions → Contents:** Read-only (Metadata read-only is added automatically)
- Nothing else. Give it an expiry you will remember; when it expires the game shows a GitHub read error until you put a new one in.

## First deploy

```bash
npm i -g wrangler
wrangler login                      # opens the browser, authorise your Cloudflare account

# run from the repo root
wrangler secret put GAME_PASSWORD   # paste the password
wrangler secret put MISTRAL_API_KEY # paste the Mistral key
wrangler secret put GITHUB_TOKEN    # paste the fine-grained token
wrangler deploy
```

`wrangler deploy` prints the URL, something like `https://eidholm.<your-subdomain>.workers.dev`.
Open it, enter the password, play.

## Changing things later

| Change | Command |
|---|---|
| New password | `wrangler secret put GAME_PASSWORD` (takes effect immediately, everyone is logged out on their next turn) |
| New Mistral key / GitHub token | `wrangler secret put MISTRAL_API_KEY` / `GITHUB_TOKEN` |
| Default model | edit `MODEL` in `wrangler.toml` (repo root), then `wrangler deploy` |
| Client or worker code | edit, then push to `main` (Cloudflare redeploys automatically) |
| World state (party, log, rules, canon) | commit to `main`. **No redeploy needed**: the Worker reads the repo live (cached ~60 s). |

## Local testing

Create `.dev.vars` in the repo root (git-ignored, never commit it):

```
GAME_PASSWORD=something
MISTRAL_API_KEY=...
GITHUB_TOKEN=...
```

Then run `wrangler dev` from the repo root and open the local URL it prints.

## The shared table (Durable Object)

The live session (seats, presence, actions, GM replies, spend) is stored in a Durable Object called `Table`, declared in `wrangler.toml`. It deploys automatically with the Worker; nothing to set up in the dashboard. **New** in the client wipes the shared scene for everyone (seats stay), so export first.

Browsers connect over a WebSocket. Because browsers can't send custom headers on a WebSocket, the client first trades the password for a signed ticket at `POST /api/ticket` (valid 60 s), then opens `/api/ws?ticket=...`. A forged or expired ticket is rejected before reaching the table.

## How the credit protection works

- `/api/check`, `/api/state` and `/api/ticket` compare the `X-Game-Password` header against the secret **before anything else**. A wrong password returns 401 and never touches GitHub or Mistral. Zero spend.
- The Mistral key exists only as a Cloudflare secret. It is never in this repo and never reaches the browser.
- The client keeps the password in `sessionStorage` (gone when the tab closes) and its seat in `localStorage`. The scene itself lives on Cloudflare, not in the browser.

## Costs to watch

- The header in the client shows tokens and estimated USD for the current session (prices are constants at the top of the `<script>` in `web/index.html`).
- Every turn re-sends canon + rules + party + the log tail + recent chat. The canon is placed first in the system prompt so the prefix is identical turn to turn, which is what prompt caching needs. Check the usage page in the Mistral console after the first sessions to see actual numbers.
- Use the **Large** toggle for climactic scenes only.

## Session workflow (state commits)

The Worker only **reads** state. After a session:

1. Click **Export** in the client to download the transcript.
2. Update `characters/party.json` and append a session entry to `campaign/log.md` (Claude can do this from the export).
3. Commit with a `session:` message. Tag milestones (`git tag session-01`).

Commit prefixes: `session:` / `turn:` for state, `canon:` for lore (only by explicit decision), `rules:` for adopted mechanics, `app:` for code.
