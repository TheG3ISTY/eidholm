# Eidholm

A techfantasy text RPG played straight from the browser. One continent, magic and technology as a single spectrum, minds of glass that can hear prayers. Mythic in scale, grim in texture.

Browsers → Cloudflare Worker (password gate + proxy) + Durable Object (the shared live table) → Mistral. Game state lives in this private repo and is read live on every turn.

## Layout

```
world/worldbuilding.md    settled canon; change only by explicit decision
rules/resolution.md       rules system, Draft 0, designed while playing
characters/party.json     living party state, updated after sessions
campaign/log.md           session log + world clock
api/worker.js             Cloudflare Worker: gate, state loader, Mistral proxy
wrangler.toml             Worker config (no secrets in here), at repo root
web/index.html            browser client, served by the Worker
meta/deployment.md        deploy, secrets, costs, session workflow
```

## Ground rules

- **The Rim stays undefined.** The Frozen Archive is a narrative joker. Nobody, GM included, explains it.
- **No secrets in the repo.** Password, Mistral key and GitHub token exist only as Cloudflare secrets.
- **A wrong password costs nothing.** The gate runs before any GitHub or Mistral call.
- Single `main` branch. Commit prefixes: `canon:` lore, `rules:` mechanics, `session:` / `turn:` state, `app:` code. Tags for milestones.

## The shared table

Everyone with the password plays the **same live scene** from their own device.

- Each player takes a **seat** (their name, plus a character name once they have one).
- Before a session, mark each character **Present** or **Absent**. This is stored on Cloudflare and syncs to everyone instantly.
- Present players post actions whenever they like. The GM answers **once every present character has acted or passed**, or earlier when anyone presses **Resolve now**.
- Posting again before the GM answers replaces your action; **Take mine back** withdraws it.
- `OOC: ...` is table talk: everyone sees it, the GM does not, and it doesn't count as your action.
- Absent characters are elsewhere in the story; the GM never narrates them.

The live session lives in a Durable Object (`Table` in `api/worker.js`). The repo stays the long-term record; export a session and commit it to the log.

## In the client

- **Codex** (header button): Party, Log, Rules and World tabs, read live from this repo.
- **Slash commands** in the input bar: `/party`, `/sheet name`, `/log`, `/rules`, `/world word`, `/codex`, `/help`.

Both read the repo through `/api/state` and never call Mistral, so they cost no tokens. The GM never sees them.

Deploying: see [meta/deployment.md](meta/deployment.md).
