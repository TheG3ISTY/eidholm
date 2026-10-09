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
| Settings username + password | you choose them; only the GM needs these |
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

## Settings (the Game Master gate)

A second lock, separate from the player password. The **Settings** button in the client asks for a username and password; behind it the GM can remove seats from the live table and delete characters from `characters/party.json`. Players can no longer remove seats at all: the server refuses it unless the admin credentials are sent.

Add these as **Secrets** (Settings → Variables and Secrets):

| Secret | What it is |
|---|---|
| `ADMIN_USERNAME` | the Settings username |
| `ADMIN_PASSWORD` | the Settings password (use a different one from `GAME_PASSWORD`) |
| `GITHUB_WRITE_TOKEN` | a **second** fine-grained token: only `TheG3ISTY/eidholm`, **Contents: Read and write**. Used for sheet edits, saving and ending sessions. |

Once unsealed, the **Party** tab in the Codex becomes an editor on that device: change any field, add or remove fields, rename, create characters, and set the world clock and location. Players always see every sheet, read-only, and their screens refresh the moment a change is saved.

Until all three exist, Settings stays sealed (and without `GITHUB_WRITE_TOKEN`, only the seat controls work). Every deletion from the party file is a real commit (`session: remove character ...`), so it can be undone from the repo history.

## The shared table (Durable Object)

The live session (seats, presence, actions, GM replies, spend) is stored in a Durable Object called `Table`, declared in `wrangler.toml`. It deploys automatically with the Worker; nothing to set up in the dashboard. Only the GM can clear the scene, by ending the session (saved) or discarding it, both in Settings.

Browsers connect over a WebSocket. Because browsers can't send custom headers on a WebSocket, the client first trades the password for a signed ticket at `POST /api/ticket` (valid 60 s), then opens `/api/ws?ticket=...`. A forged or expired ticket is rejected before reaching the table.

## The bouncer (wrong-password lockout)

Both gates count wrong guesses per connection (IP), separately. After **5 wrong attempts within 15 minutes**, that gate is shut for that connection for **15 minutes**, and passwords aren't even checked while it's shut. A correct password clears the count. Failing the Settings login never blocks normal play.

People on the same Wi-Fi share one connection as far as this is concerned. If you lock yourself out, wait it out, or play from mobile data. The numbers live at the top of `api/worker.js` (`MAX_FAILS`, `FAIL_WINDOW_MS`, `LOCKOUT_MS`).

## How the credit protection works

- `/api/check`, `/api/state` and `/api/ticket` compare the `X-Game-Password` header against the secret **before anything else**. A wrong password returns 401 and never touches GitHub or Mistral. Zero spend.
- The Mistral key exists only as a Cloudflare secret. It is never in this repo and never reaches the browser.
- The client keeps the password in `sessionStorage` (gone when the tab closes) and its seat in `localStorage`. The scene itself lives on Cloudflare, not in the browser.

## Costs to watch

- The header in the client shows tokens and estimated USD for the current session (prices are constants at the top of the `<script>` in `web/index.html`).
- **The GM only reads what the scene needs.** At the end of every answer it writes a hidden scene tag (mode, place, people present, factions, topics); the next turn loads just the matching canon sections, economy and rules sections, and full entries for the people present or named. Everything else appears in an index (titles and one line per person), and the GM can call a `lookup` tool for anything it needs. A keyword scan of what the players typed backs the tag up. A typical turn is roughly a third of what it would be with the whole library (about 14,000 to 20,000 characters instead of ~57,000); character creation loads nearly everything, on purpose.
- The logic lives in `api/context.js` (chunking, topics, selection). Stable parts (instructions, core canon, dice rules) come first in the prompt, scene parts after.
- Use the **Large** toggle for climactic scenes only.

## Session workflow (saving)

Saving is built in, with two buttons:

- **Save** (on your own seat chip in the roster strip, anyone at the table): a checkpoint. The transcript so far is committed to this session's archive file (`session: save session N (checkpoint by ...)`), together with `characters/party.json` if any sheet or the clock changed; play continues. Every later save updates the same file. One save per 30 seconds for the whole table; the header shows when and by whom it was last saved. The live scene is already stored safely on Cloudflare, so Save is about getting the record into the repo early, not about rescuing the game.
- **End session** (Settings, GM only): closes the evening, as below.

In **Settings → The session**:

1. **End session…** reads the live scene and asks the GM (one small Mistral call) to draft a summary: what happened, debts and enemies, suggested sheet changes, who joined or left, open threads. Without Mistral, or if the call fails, you write the summary yourself in the same box.
2. Give the session a **title**, check the **world clock**, edit the summary.
3. **Commit and end session** writes **one commit** (`session: end session N: Title`) containing:
   - `campaign/sessions/YYYY-MM-DD-session-NN.md`, the full transcript word for word, with arrivals, departures and any unresolved actions noted (the same file any checkpoint saves wrote to; a session keeps its number and date even past midnight);
   - a new entry at the bottom of `campaign/log.md`, which is what the GM reads every turn;
   - `characters/party.json` with the live sheets and game clock, and the world clock line if it changed.

   The transcript is taken at the moment you commit, so lines posted while you were editing are included. Then the scene clears for everyone; seats stay.

Players joining, leaving or stepping away mid-session are recorded as lines in the scene, so the archive, the summary and the GM all know who was there for what.

**Discard scene** (also in Settings) throws the scene away without saving, for test runs, including any sheet changes since the last save. Players can no longer clear the scene themselves.

## The GM login

A third login, below Settings, for whoever runs a session as human GM. Add two more secrets in Cloudflare (**Settings → Variables and Secrets**, type *Secret*):

- `GM_USERNAME`
- `GM_PASSWORD`

It opens the GM seat and desk, the GM's hidden dice, DCs and ACs, the NPCs' secrets (People tab) and the clock. It cannot switch between AI and human GM, edit or delete sheets directly, free or remove seats, end or discard sessions, or see the model switch and spend; those stay with Settings. Wrong guesses are counted by the bouncer separately from the other two locks. Without these two secrets, the GM login simply never opens; the owner can still take the GM seat from Settings.

## The model, and running without one

The GM model is any provider with an OpenAI-style chat completions API (Mistral is one). By default it calls Mistral with the `MISTRAL_API_KEY` secret. To use another provider, set two more:

- `LLM_URL`: the provider's chat completions URL (a variable)
- `LLM_API_KEY`: its key (a secret)

and set `MODEL` / `MODEL_LARGE` in `wrangler.toml` to that provider's model names. The model must support tool calling.

To run with a person as GM instead, switch **Settings → Who runs the game** to *Human game master* and take the GM seat. No model is called at all in that mode, so it works with no key set.

## Character sheets during play

The sheets live on the table (the `Table` Durable Object) while a session runs, so every hit, coin, mark and level is instant and nothing waits on GitHub. They go back to `characters/party.json` on **Save**, **End session**, and every edit made in the unsealed Party tab (that edit commits everything that changed at the table too, so nothing is lost either way). The header shows "sheets unsaved" until then. A hand edit made directly in the repo is picked up after End session or Discard.
