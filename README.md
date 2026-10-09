# Eidholm

A techfantasy text RPG played straight from the browser. One continent, magic and technology as a single spectrum, minds of glass that can hear prayers. Mythic in scale, grim in texture.

Browsers → Cloudflare Worker (password gate + proxy) + Durable Object (the shared live table) → Mistral. Game state lives in this private repo and is read live on every turn.

## Layout

```
world/worldbuilding.md    settled canon; change only by explicit decision
rules/resolution.md       dice and how the table resolves things
rules/characters.md       the character system: stats, skills, levels, capstones, dying, the clock
rules/spells.md           the spellbook: 55 named spells (tiers 1-5), learning, miscants, tier-6 workings
characters/party.json     character sheets and the game clock, written at Save / End
campaign/log.md           session log + world clock
campaign/cast.json        people the GM remembers (written at Save / End)
api/worker.js             Cloudflare Worker: gate, state loader, Mistral proxy, shared table
api/dice.js               dice engine: real randomness for players and the GM
api/characters.js         character rules: sheets, derived numbers, marks, levels, harm, time
api/spells.js             reads the spellbook tables; miscant ranges
api/context.js            what the GM reads each turn: scene-based loading of canon, rules, economy, people
rules/economy.md          currency, prices, gear tiers, item scales
wrangler.toml             Worker config (no secrets in here), at repo root
web/index.html            browser client, served by the Worker
meta/deployment.md        deploy, secrets, costs, session workflow
```

## Ground rules

- **The Rim stays undefined.** The Frozen Archive is a narrative joker. Nobody, GM included, explains it.
- **No secrets in the repo.** Passwords, the Mistral key and both GitHub tokens exist only as Cloudflare secrets.
- **A wrong password costs nothing.** The gate runs before any GitHub or Mistral call, and 5 wrong guesses lock that connection out for 15 minutes.
- Single `main` branch. Commit prefixes: `canon:` lore, `rules:` mechanics, `session:` / `turn:` state, `app:` code. Tags for milestones.

## The shared table

Everyone with the password plays the **same live scene** from their own device.

- Each player takes a **seat** (their name, plus a character name once they have one).
- Before a session, mark each character **Present** or **Absent**. This is stored on Cloudflare and syncs to everyone instantly.
- Present players post actions whenever they like. The GM answers **once every present character has acted or passed**, or earlier when anyone presses **Resolve now**.
- Posting again before the GM answers replaces your action; **Take mine back** withdraws it.
- `OOC: ...` is table talk: everyone sees it, the GM does not, and it doesn't count as your action.
- **Settings** (separate username + password) lets the GM remove seats, and turns the Party tab into an editor: edit, create, rename and delete character sheets, set the world clock. Every change is a commit. Players see all sheets read-only and can't remove anyone.
- Absent characters are elsewhere in the story; the GM never narrates them.
- **Characters** are made on the **Create character** screen (button on your own seat chip): a zero-sum point buy over eight stats (S.P.E.C.I.A.L. + Resonance), a backstory, three items from the starting kit, and two tier-1 spells. Skills start untrained and grow by use; every two skill ranks is a level, up to 50. The sheets live on the table during play (Codex → Party, everyone sees all of them) and the server does every number: modifiers, HP, AC, Resonance, marks, death saves, the clock. Rules in `rules/characters.md`.
- **Dice:** the GM requests rolls; they appear as buttons on the left side of that player's screen, and `/roll` rolls them all in order. The server rolls honestly and judges them by 5e rules (advantage/disadvantage, DC, AC, criticals, damage on a hit). The GM rolls its own dice through a tool; those stay behind the screen unless the GM shows them (Settings). An idle die at the bottom left is just for fidgeting.

- Arrivals, departures and presence changes are recorded in the scene as they happen.
- **People:** the GM remembers NPCs who matter (debts, blood, secrets, power, minds of glass, anyone the players care about or meet twice) in `campaign/cast.json`. `/remember name` asks it to. Codex → People shows the public half to players; wants, secrets and notes are GM-only.
- **Save** (on your own seat chip, anyone) commits the transcript so far to this session's archive file, plus the sheets if they changed; play continues.
- **End session** (Settings, GM only) archives the final transcript to `campaign/sessions/`, adds a GM-drafted, GM-edited summary to `campaign/log.md` and updates the world clock, all in one commit, then clears the scene.

The live session lives in a Durable Object (`Table` in `api/worker.js`); the repo is the long-term record.

## In the client

- **Codex** (header button): Party, Log, Rules and World tabs, read live from this repo.
- **Slash commands** in the input bar: `/roll`, `/remember name`, `/people`, `/party`, `/sheet name`, `/log`, `/rules`, `/economy`, `/world word`, `/table`, `/codex`, `/help`.

Except `/roll`, they read the repo through `/api/state`, never call Mistral, cost no tokens, and the GM never sees them.

Deploying: see [meta/deployment.md](meta/deployment.md).
