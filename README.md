# Eidholm

A techfantasy text RPG played straight from the browser. One continent, magic and technology as a single spectrum, minds of glass that can hear prayers. Mythic in scale, grim in texture.

Browser → Cloudflare Worker (password gate + proxy) → Mistral. Game state lives in this private repo and is read live on every turn.

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

## In the client

- **Codex** (header button): Party, Log, Rules and World tabs, read live from this repo.
- **Slash commands** in the input bar: `/party`, `/sheet name`, `/log`, `/rules`, `/world word`, `/codex`, `/help`.

Both read the repo through `/api/state` and never call Mistral, so they cost no tokens. The GM never sees them.

Deploying: see [meta/deployment.md](meta/deployment.md).
