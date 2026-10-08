// Eidholm RPG: Cloudflare Worker + shared table (Durable Object)
//
// HTTP (all gated by X-Game-Password):
//   POST /api/check   password check, no side effects
//   POST /api/state   read-only repo state for the Codex (never calls Mistral)
//   POST /api/ticket  short-lived signed ticket for opening the live connection
//   POST /api/admin/* settings; also needs X-Admin-User + X-Admin-Password
// WebSocket:
//   GET  /api/ws?ticket=...   live connection to the shared table
//
// Secrets: GAME_PASSWORD, MISTRAL_API_KEY, GITHUB_TOKEN (read-only)
// Settings secrets: ADMIN_USERNAME, ADMIN_PASSWORD, GITHUB_WRITE_TOKEN (contents read+write)
// Vars:    MODEL, MODEL_LARGE, GITHUB_REPO, GITHUB_BRANCH
// Optional dev overrides: MISTRAL_URL, GITHUB_API

import { DurableObject } from "cloudflare:workers";

const STATE_FILES = {
  canon: "world/worldbuilding.md",
  rules: "rules/resolution.md",
  party: "characters/party.json",
  log: "campaign/log.md",
};
const LOG_TAIL_CHARS = 4000;
const STATE_CACHE_SECONDS = 60;
const TICKET_TTL_MS = 60_000;
const MAX_TEXT = 2000;          // per action / table-talk message
const MAX_NAME = 40;
const MAX_STORED_MESSAGES = 1500;   // a long evening; End session archives it all
const SNAPSHOT_MESSAGES = 300;
const GM_HISTORY_ROUNDS = 12;   // past rounds sent to the GM for continuity
const STALE_RESOLVE_MS = 120_000;
const SAVE_COOLDOWN_MS = 30_000;   // one checkpoint save per 30 s for the whole table

// The bouncer: wrong guesses per connection, per gate.
const MAX_FAILS = 5;
const FAIL_WINDOW_MS = 15 * 60_000;
const LOCKOUT_MS = 15 * 60_000;

// ======================================================================
// Front door
// ======================================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/ws") {
      // Browsers cannot send custom headers on a WebSocket, so the password
      // is exchanged for a short-lived signed ticket first (POST /api/ticket).
      if (request.headers.get("Upgrade") !== "websocket") return json({ error: "Expected WebSocket" }, 426);
      const ok = await verifyTicket(url.searchParams.get("ticket"), env.GAME_PASSWORD);
      if (!ok) return json({ error: "The gate does not open." }, 401);
      const stub = env.TABLE.get(env.TABLE.idFromName("main"));
      return stub.fetch(request);
    }

    if (url.pathname.startsWith("/api/")) {
      if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

      // The gate. Nothing below this line runs on a wrong password, and a
      // connection that keeps guessing wrong is shut out before we even look.
      const bouncer = env.BOUNCER.get(env.BOUNCER.idFromName(clientIp(request)));
      const player = await guarded(bouncer, "player", () =>
        passwordMatches(request.headers.get("X-Game-Password"), env.GAME_PASSWORD));
      if (player.locked) return lockedOut(player.retryAfter);
      if (!player.ok) return json({ error: "The gate does not open." }, 401);

      if (url.pathname === "/api/check") return json({ ok: true });
      if (url.pathname === "/api/ticket") return json({ ticket: await makeTicket(env.GAME_PASSWORD) });
      if (url.pathname === "/api/save") {
        if (!env.GITHUB_WRITE_TOKEN) return json({ error: "Saving isn't set up yet (no GITHUB_WRITE_TOKEN on the Worker)." }, 501);
        const body = await request.json().catch(() => ({}));
        try {
          return json(await saveCheckpoint(env, body.seatId));
        } catch (err) {
          return json({ error: err.message, retryAfter: err.retryAfter }, err.status || 502);
        }
      }

      // Second gate: the Game Master's settings. Needs the admin password as well.
      if (url.pathname.startsWith("/api/admin/")) {
        // Username and password are both checked, always both, so a wrong
        // answer never reveals which half was wrong.
        const admin = await guarded(bouncer, "admin", async () => {
          const [userOk, passOk] = await Promise.all([
            passwordMatches(headerText(request, "X-Admin-User"), env.ADMIN_USERNAME),
            passwordMatches(headerText(request, "X-Admin-Password"), env.ADMIN_PASSWORD),
          ]);
          return userOk && passOk;
        });
        if (admin.locked) return lockedOut(admin.retryAfter);
        if (!admin.ok) return json({ error: "The settings stay sealed." }, 403);
        return handleAdmin(url.pathname.slice("/api/admin/".length), request, env);
      }
      if (url.pathname === "/api/state") {
        try {
          return json(await loadState(env));
        } catch (err) {
          return json({ error: `Could not read game state from GitHub: ${err.message}` }, 502);
        }
      }
      return json({ error: "Not found" }, 404);
    }

    return env.ASSETS.fetch(request);
  },
};

// ======================================================================
// Settings (admin)
// ======================================================================

async function handleAdmin(action, request, env) {
  let body = {};
  try { body = await request.json(); } catch {}

  if (action === "check") {
    return json({ ok: true, canWriteRepo: !!env.GITHUB_WRITE_TOKEN });
  }

  if (action === "remove-seat") {
    const stub = env.TABLE.get(env.TABLE.idFromName("main"));
    const res = await stub.fetch("https://table/admin", {
      method: "POST",
      body: JSON.stringify({ t: "removeSeat", id: body.id }),
    });
    return new Response(res.body, { status: res.status, headers: { "Content-Type": "application/json" } });
  }

  if (action === "delete-character" || action === "save-character" || action === "save-meta") {
    if (!env.GITHUB_WRITE_TOKEN) {
      return json({ error: "No GITHUB_WRITE_TOKEN is set, so the party file can't be changed from here." }, 501);
    }
    try {
      if (action === "delete-character") return json(await deleteCharacter(env, clean(body.name, 200)));
      if (action === "save-character") return json(await saveCharacter(env, body.original, body.character));
      return json(await saveMeta(env, body));
    } catch (err) {
      return json({ error: err.message }, err.status || 502);
    }
  }

  if (action === "prepare-end") return json(await prepareEnd(env));

  if (action === "end-session") {
    if (!env.GITHUB_WRITE_TOKEN) return json({ error: "No GITHUB_WRITE_TOKEN is set, so nothing can be saved to the repo." }, 501);
    try {
      return json(await endSession(env, body));
    } catch (err) {
      return json({ error: err.message }, err.status || 502);
    }
  }

  if (action === "discard-scene") {
    await tableCall(env, { t: "reset" });
    return json({ ok: true });
  }

  return json({ error: "Unknown setting." }, 404);
}

async function tableCall(env, msg) {
  const stub = env.TABLE.get(env.TABLE.idFromName("main"));
  const res = await stub.fetch("https://table/admin", { method: "POST", body: JSON.stringify(msg) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(data.error || `Table error ${res.status}`, res.status);
  return data;
}

// ---------------- end of session ----------------

async function prepareEnd(env) {
  const scene = await tableCall(env, { t: "export" });
  const repo = await loadState(env);
  const sessionNo = scene.session?.no || nextSessionNumber(repo.log);
  let party = {};
  try { party = JSON.parse(repo.party || "{}"); } catch {}
  const playable = scene.messages.filter((m) => m.kind !== "event");

  let draft = "", draftError = null;
  if (!playable.length) {
    draftError = "The scene is empty, so there is nothing to summarise.";
  } else {
    try {
      const out = await callMistral(env, env.MODEL, [
        { role: "system", content: SUMMARY_PROMPT },
        { role: "user", content: transcriptText(scene).slice(-60000) },
      ]);
      draft = out.reply.trim();
    } catch (err) {
      draftError = `The GM couldn't draft a summary (${err.message}). Write it yourself below.`;
    }
  }
  return {
    sessionNo,
    date: today(),
    worldClock: party.world_clock || "",
    messageCount: scene.messages.length,
    rounds: scene.round,
    pending: scene.messages.filter((m) => m.round === scene.round && isPending(m)).length,
    resolving: scene.resolving,
    draft,
    draftError,
    archivePath: scene.session?.path || archivePath(sessionNo, today()),
    savedAt: scene.session?.savedAt || 0,
  };
}

const SUMMARY_PROMPT = `You are the chronicler of EIDHOLM, a techfantasy tabletop RPG. Summarise the session transcript you are given for the campaign log the Game Master will read before the next session.

Write Markdown bullets only, no heading, under 250 words, in this order:
- What happened, in order, with character names.
- Decisions, debts, promises, enemies and allies made.
- Changes to characters worth writing onto their sheets (wounds, scars, gear, standing). Phrase them as suggestions; do not invent numbers.
- Who joined or left the table during the session, and roughly when.
- Open threads to pick up next time.
Never explain the Rim or the Frozen Archive. Do not invent events that are not in the transcript.`;

async function endSession(env, body) {
  const title = clean(body.title, 120) || "Untitled";
  const summary = clean(body.summary, 8000, true);
  const worldClock = clean(body.worldClock, 120);
  if (!summary) throw httpError("Write at least a short summary before ending the session.", 400);

  // Take the scene as it is now, not as it was when the draft was made.
  const scene = await tableCall(env, { t: "export" });
  if (scene.resolving) throw httpError("The GM is answering right now. Wait a moment, then end the session.", 409);
  const upToId = scene.messages.reduce((mx, m) => Math.max(mx, m.id), 0);

  const repo = await readFilesFresh(env, [STATE_FILES.log, STATE_FILES.party]);
  // A session that was already checkpointed keeps its number, date and file.
  const sessionNo = scene.session?.no || nextSessionNumber(repo[STATE_FILES.log]);
  const date = scene.session?.date || today();
  const path = scene.session?.path || archivePath(sessionNo, date);

  // 1. the archive
  const archive = transcriptMarkdown(scene, { sessionNo, title, date, worldClock });

  // 2. the log: append the entry, keep the "World clock" line at the top current
  let log = repo[STATE_FILES.log] || "# Eidholm: Campaign Log\n";
  if (worldClock) {
    log = /^\*\*World clock:\*\*.*$/m.test(log)
      ? log.replace(/^\*\*World clock:\*\*.*$/m, `**World clock:** ${worldClock}`)
      : log.replace(/^(# .*\n)/, `$1\n**World clock:** ${worldClock}\n`);
  }
  log = log.replace(/\n*No sessions played yet\.[^\n]*\n?/, "\n");
  log = log.replace(/\s*$/, "\n") + `\n## Session ${sessionNo}: ${title} (${date})\n` +
    (worldClock ? `**World clock:** ${worldClock}  \n` : "") +
    `**Transcript:** [${path}](${path.replace(/^campaign\//, "")})\n\n${summary}\n`;

  const files = { [path]: archive, [STATE_FILES.log]: log };

  // 3. the party file's clock, if it changed
  if (worldClock && repo[STATE_FILES.party]) {
    try {
      const party = JSON.parse(repo[STATE_FILES.party]);
      if (party.world_clock !== worldClock) {
        party.world_clock = worldClock;
        files[STATE_FILES.party] = JSON.stringify(party, null, 2) + "\n";
      }
    } catch {}
  }

  // All of it as ONE commit.
  const sha = await commitFiles(env, files, `session: end session ${sessionNo}: ${title}`);

  for (const f of [STATE_FILES.log, STATE_FILES.party]) {
    await caches.default.delete(new Request(`https://eidholm-state.cache/${env.GITHUB_BRANCH}/${f}`));
  }
  await tableCall(env, { t: "reset", upToId });
  await tableCall(env, { t: "partyChanged" });
  return { ok: true, sessionNo, archivePath: path, commit: sha };
}

// Mid-session checkpoint: the transcript so far goes into this session's
// archive file (the same file every time); the scene keeps going.
async function saveCheckpoint(env, seatId) {
  let scene = await tableCall(env, { t: "export" });
  let session = scene.session?.no ? scene.session : null;
  if (!session) {
    const repo = await readFilesFresh(env, [STATE_FILES.log]);
    const no = nextSessionNumber(repo[STATE_FILES.log]);
    session = { no, date: today(), path: archivePath(no, today()) };
  }
  const claim = await tableCall(env, { t: "claimSave", session: { no: session.no, date: session.date, path: session.path } })
    .catch((err) => { if (err.status === 429) err.retryAfter = 30; throw err; });
  session = claim.session;
  scene = await tableCall(env, { t: "export" });

  const seat = scene.seats.find((s) => s.id === seatId);
  const by = seat ? label(seat) : "the table";
  try {
    const archive = transcriptMarkdown(scene, { sessionNo: session.no, title: "in progress", date: session.date, worldClock: "" });
    await commitFiles(env, { [session.path]: archive }, `session: save session ${session.no} (checkpoint by ${by})`);
    await tableCall(env, { t: "markSaved", ok: true, by });
    return { ok: true, sessionNo: session.no, path: session.path };
  } catch (err) {
    await tableCall(env, { t: "markSaved", ok: false }).catch(() => {});
    throw err;
  }
}

function nextSessionNumber(log) {
  const nums = [...String(log || "").matchAll(/^## Session (\d+)/gm)].map((m) => Number(m[1]));
  return (nums.length ? Math.max(...nums) : 0) + 1;
}

function archivePath(n, date) {
  return `campaign/sessions/${date}-session-${String(n).padStart(2, "0")}.md`;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function who(m) {
  return m.character ? `${m.character} (${m.author})` : m.author;
}

// Plain text for the summariser.
function transcriptText(scene) {
  return scene.messages.map((m) => {
    if (m.kind === "gm") return `GM: ${m.text}`;
    if (m.kind === "act") return `[round ${m.round}] ${who(m)}: ${m.text}`;
    if (m.kind === "pass") return `[round ${m.round}] ${who(m)} passes.`;
    if (m.kind === "event") return `[round ${m.round}] (table) ${m.text}`;
    return `(out of character) ${m.author}: ${m.text}`;
  }).join("\n\n");
}

// The archive file: the whole session, word for word.
function transcriptMarkdown(scene, { sessionNo, title, date, worldClock }) {
  const tokens = ["small", "large"].reduce((n, t) => n + (scene.spend?.[t]?.in || 0) + (scene.spend?.[t]?.out || 0), 0);
  const events = scene.messages.filter((m) => m.kind === "event");
  const body = scene.messages.map((m) => {
    if (m.kind === "gm") return `**GM:**\n\n${m.text}`;
    if (m.kind === "act") return `**${who(m)}:** ${m.text}`;
    if (m.kind === "pass") return `*${who(m)} passes.*`;
    if (m.kind === "event") return `> *${m.text}*`;
    return `> OOC ${m.author}: ${m.text}`;
  }).join("\n\n");
  const pending = scene.messages.filter((m) => m.round === scene.round && isPending(m));
  return `# Session ${sessionNo}: ${title}

- **Date:** ${date}${title === "in progress" ? "\n- **Status:** in progress (checkpoint save)" : ""}
- **World clock at the end:** ${worldClock || "unchanged"}
- **Rounds:** ${scene.round - (pending.length ? 0 : 1)}
- **Seats at the end:** ${scene.seats.map((s) => `${label(s)}${s.present ? "" : " (absent)"}`).join(", ") || "none"}
- **Arrivals and departures:** ${events.length ? events.map((e) => e.text).join(" · ") : "none"}
- **Tokens:** ${tokens.toLocaleString("en")}
${pending.length ? `- **Unresolved at the end:** ${pending.length} action(s) were still waiting for the GM.\n` : ""}
---

${body || "*Nothing was played.*"}
`;
}

async function readFilesFresh(env, paths) {
  const base = env.GITHUB_API || "https://api.github.com";
  const out = {};
  await Promise.all(paths.map(async (path) => {
    const res = await fetch(`${base}/repos/${env.GITHUB_REPO}/contents/${path}?ref=${env.GITHUB_BRANCH}`, {
      headers: {
        Authorization: `Bearer ${env.GITHUB_WRITE_TOKEN}`,
        Accept: "application/vnd.github.raw+json",
        "User-Agent": "eidholm-worker",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (res.status === 404) { out[path] = ""; return; }
    if (!res.ok) throw httpError(`Could not read ${path} (GitHub ${res.status}).`, 502);
    out[path] = await res.text();
  }));
  return out;
}

// Several files in a single commit, via the Git Data API.
async function commitFiles(env, files, message) {
  const base = env.GITHUB_API || "https://api.github.com";
  const repo = `${base}/repos/${env.GITHUB_REPO}`;
  const headers = {
    Authorization: `Bearer ${env.GITHUB_WRITE_TOKEN}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "eidholm-worker",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const gh = async (path, init = {}) => {
    const res = await fetch(repo + path, { headers, ...init });
    if (!res.ok) throw httpError(`GitHub refused the save (${res.status} on ${path.split("/").slice(0, 3).join("/")}). Check the write token's permissions.`, 502);
    return res.json();
  };
  const ref = await gh(`/git/ref/heads/${env.GITHUB_BRANCH}`);
  const parent = await gh(`/git/commits/${ref.object.sha}`);
  const tree = await gh(`/git/trees`, {
    method: "POST",
    body: JSON.stringify({
      base_tree: parent.tree.sha,
      tree: Object.entries(files).map(([path, content]) => ({ path, mode: "100644", type: "blob", content })),
    }),
  });
  const commit = await gh(`/git/commits`, {
    method: "POST",
    body: JSON.stringify({ message, tree: tree.sha, parents: [ref.object.sha] }),
  });
  await gh(`/git/refs/heads/${env.GITHUB_BRANCH}`, { method: "PATCH", body: JSON.stringify({ sha: commit.sha }) });
  return commit.sha;
}

// Every change to characters/party.json goes through here: read the current
// file, change it, write it back as a real commit (so it is visible and
// recoverable in the repo history), then tell everyone at the table.
async function updatePartyFile(env, message, mutate) {
  const path = STATE_FILES.party;
  const base = env.GITHUB_API || "https://api.github.com";
  const url = `${base}/repos/${env.GITHUB_REPO}/contents/${path}`;
  const headers = {
    Authorization: `Bearer ${env.GITHUB_WRITE_TOKEN}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "eidholm-worker",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const cur = await fetch(`${url}?ref=${env.GITHUB_BRANCH}`, { headers });
  if (!cur.ok) throw httpError(`Could not read the party file (GitHub ${cur.status}).`, 502);
  const file = await cur.json();
  let data;
  try {
    data = JSON.parse(fromBase64(file.content) || "{}");
  } catch {
    throw httpError("party.json in the repo is not valid JSON. Fix it there first.", 409);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) data = {};
  data.party = partyList(data);

  const result = mutate(data);

  const put = await fetch(url, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      content: toBase64(JSON.stringify(data, null, 2) + "\n"),
      sha: file.sha,
      branch: env.GITHUB_BRANCH,
    }),
  });
  if (put.status === 409) throw httpError("The party file changed at the same moment. Reload and try again.", 409);
  if (!put.ok) throw httpError(`GitHub refused the change (${put.status}). Check the write token's permissions.`, 502);

  // The Codex and the GM see the change immediately, and every open screen refreshes.
  await caches.default.delete(new Request(`https://eidholm-state.cache/${env.GITHUB_BRANCH}/${path}`));
  const stub = env.TABLE.get(env.TABLE.idFromName("main"));
  await stub.fetch("https://table/admin", { method: "POST", body: JSON.stringify({ t: "partyChanged" }) }).catch(() => {});
  return { ok: true, ...result };
}

// Normalise the roster to an array of { name, ... } whatever shape it had.
function partyList(data) {
  const p = data.party ?? data.characters ?? [];
  delete data.characters;
  if (Array.isArray(p)) return p.filter((m) => m && typeof m === "object");
  if (p && typeof p === "object") return Object.entries(p).map(([name, v]) => ({ name, ...(v || {}) }));
  return [];
}

function sameName(a, b) {
  return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
}

async function deleteCharacter(env, name) {
  if (!name) throw httpError("Which character?", 400);
  let removed;
  return updatePartyFile(env, `session: remove character ${name} (via game settings)`, (data) => {
    const i = data.party.findIndex((m) => sameName(m.name, name));
    if (i < 0) throw httpError(`No character called "${name}" in the party file.`, 404);
    removed = data.party[i].name;
    data.party.splice(i, 1);
    return { removed };
  });
}

async function saveCharacter(env, original, character) {
  if (!character || typeof character !== "object" || Array.isArray(character)) throw httpError("That isn't a character sheet.", 400);
  const name = clean(character.name, 80);
  if (!name) throw httpError("Every character needs a name.", 400);
  character.name = name;
  if (JSON.stringify(character).length > 20000) throw httpError("That sheet is too large.", 400);

  const what = !original ? `create character ${name}`
    : sameName(original, name) ? `edit character ${name}`
    : `rename character ${original} to ${name}`;
  return updatePartyFile(env, `session: ${what} (via game settings)`, (data) => {
    const clash = data.party.findIndex((m) => sameName(m.name, name));
    if (original) {
      const i = data.party.findIndex((m) => sameName(m.name, original));
      if (i < 0) throw httpError(`"${original}" is no longer in the party file. Reload first.`, 409);
      if (clash >= 0 && clash !== i) throw httpError(`There is already a character called "${name}".`, 409);
      data.party[i] = character;
    } else {
      if (clash >= 0) throw httpError(`There is already a character called "${name}".`, 409);
      data.party.push(character);
    }
    return { saved: name };
  });
}

async function saveMeta(env, body) {
  return updatePartyFile(env, "session: set world clock / location (via game settings)", (data) => {
    if (typeof body.world_clock === "string") data.world_clock = clean(body.world_clock, 120);
    if (typeof body.location === "string") data.location = clean(body.location, 120) || null;
    return {};
  });
}

function httpError(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(b64) {
  const bin = atob(String(b64).replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

// Header values are sent URI-encoded so names with umlauts or accents survive.
function headerText(request, name) {
  const v = request.headers.get(name);
  if (!v) return "";
  try { return decodeURIComponent(v); } catch { return v; }
}

// ======================================================================
// The shared table
// ======================================================================
//
// One Durable Object instance ("main") holds the live session:
//   seats     who is at the table, and whether their character is present
//   messages  actions, passes, table talk and GM replies, grouped by round
// The GM resolves a round automatically once every present seat has acted
// or passed, or earlier when anyone presses Resolve.

export class Table extends DurableObject {
  async fetch(request) {
    // Admin commands arrive as plain POSTs from the Worker itself, which has
    // already checked the admin username and password. Players only ever
    // reach the table through the WebSocket below.
    if (request.headers.get("Upgrade") !== "websocket") {
      const msg = await request.json().catch(() => ({}));
      const state = await this.load();
      if (msg.t === "removeSeat") {
        const gone = state.seats.find((s) => s.id === msg.id);
        if (!gone) return json({ error: "That seat no longer exists." }, 404);
        state.seats = state.seats.filter((s) => s.id !== msg.id);
        addEvent(state, `${label(gone)} leaves the table.`, gone);
        state.messages = state.messages.filter((m) => !(m.round === state.round && isPending(m) && m.seatId === msg.id));
        if (!(await this.maybeAutoResolve(state))) await this.commit(state);
        return json({ ok: true });
      }
      if (msg.t === "export") {
        return json({ seats: state.seats, messages: state.messages, round: state.round, spend: state.spend, resolving: isResolving(state), session: state.session });
      }
      if (msg.t === "claimSave") {
        // Cooldown, checked and claimed in one step so two players can't both save at once.
        const last = state.session?.savingAt || state.session?.savedAt || 0;
        const wait = SAVE_COOLDOWN_MS - (Date.now() - last);
        if (wait > 0) return json({ error: `Saved moments ago. Next save possible in ${Math.ceil(wait / 1000)} s.`, retryAfter: Math.ceil(wait / 1000) }, 429);
        state.session = { ...(state.session || {}), ...(msg.session || {}), savingAt: Date.now() };
        await this.save(state);
        return json({ ok: true, session: state.session });
      }
      if (msg.t === "markSaved") {
        state.session = { ...(state.session || {}), savingAt: 0, savedAt: msg.ok ? Date.now() : state.session?.savedAt || 0, savedBy: msg.ok ? msg.by : state.session?.savedBy };
        await this.commit(state);
        return json({ ok: true });
      }
      if (msg.t === "reset") {
        // Only clear what was archived: anything newer stays for the next session.
        const upTo = Number(msg.upToId) || Infinity;
        state.messages = state.messages.filter((m) => m.id > upTo);
        for (const m of state.messages) m.round = 1;
        state.round = 1;
        state.resolvingSince = 0;
        state.spend = { small: { in: 0, out: 0 }, large: { in: 0, out: 0 } };
        state.session = null;
        await this.commit(state);
        return json({ ok: true });
      }
      if (msg.t === "partyChanged") {
        const payload = JSON.stringify({ t: "party-changed" });
        for (const ws of this.ctx.getWebSockets()) { try { ws.send(payload); } catch {} }
        return json({ ok: true });
      }
      return json({ error: "Unknown admin command." }, 400);
    }

    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    const state = await this.load();
    pair[1].send(JSON.stringify(this.snapshot(state)));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    try {
      await this.handle(ws, msg);
    } catch (err) {
      send(ws, { t: "error", text: err.message || String(err) });
    }
  }

  async webSocketClose(ws, code) {
    try { ws.close(code, "bye"); } catch {}
  }

  // ---------------- state ----------------

  async load() {
    const s = (await this.ctx.storage.get("table")) || {};
    return {
      seats: s.seats || [],
      messages: s.messages || [],
      round: s.round || 1,
      resolvingSince: s.resolvingSince || 0,
      tier: s.tier || "small",
      spend: s.spend || { small: { in: 0, out: 0 }, large: { in: 0, out: 0 } },
      nextId: s.nextId || 1,
      session: s.session || null,   // { no, date, path, savedAt, savedBy } once first saved
    };
  }

  async save(state) {
    if (state.messages.length > MAX_STORED_MESSAGES) {
      state.messages = state.messages.slice(-MAX_STORED_MESSAGES);
    }
    await this.ctx.storage.put("table", state);
  }

  snapshot(state) {
    return {
      t: "state",
      seats: state.seats,
      messages: state.messages.slice(-SNAPSHOT_MESSAGES),
      round: state.round,
      resolving: isResolving(state),
      tier: state.tier,
      spend: state.spend,
      saved: state.session?.savedAt ? { at: state.session.savedAt, by: state.session.savedBy, no: state.session.no } : null,
    };
  }

  broadcast(state) {
    const payload = JSON.stringify(this.snapshot(state));
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(payload); } catch {}
    }
  }

  async commit(state) {
    await this.save(state);
    this.broadcast(state);
  }

  // ---------------- commands ----------------

  async handle(ws, msg) {
    const state = await this.load();
    const seat = (id) => state.seats.find((s) => s.id === id);

    switch (msg.t) {
      case "join": {
        const player = clean(msg.player, MAX_NAME);
        if (!player) throw new Error("A name is needed to take a seat.");
        const s = { id: "s" + crypto.randomUUID().slice(0, 8), player, character: clean(msg.character, MAX_NAME), present: true };
        state.seats.push(s);
        addEvent(state, s.character ? `${s.character} (${s.player}) takes a seat.` : `${s.player} takes a seat, without a character yet.`, s);
        send(ws, { t: "joined", seatId: s.id });
        return this.commit(state);
      }

      case "seat": {
        const s = seat(msg.id);
        if (!s) throw new Error("That seat no longer exists.");
        const p = msg.patch || {};
        const before = label(s);
        if (typeof p.player === "string" && clean(p.player, MAX_NAME)) s.player = clean(p.player, MAX_NAME);
        if (typeof p.character === "string") s.character = clean(p.character, MAX_NAME);
        if (label(s) !== before) addEvent(state, `${before} is now known as ${label(s)}.`, s);
        if (typeof p.present === "boolean" && p.present !== s.present) {
          s.present = p.present;
          addEvent(state, s.present ? `${label(s)} is back at the table.` : `${label(s)} steps away (marked absent).`, s);
        }
        // Marking someone absent can complete a round.
        if (await this.maybeAutoResolve(state)) return;
        return this.commit(state);
      }

      case "removeSeat":
        throw new Error("Only the Game Master can remove seats, from Settings.");

      case "act":
      case "pass": {
        if (isResolving(state)) throw new Error("The GM is already answering. Hold that thought.");
        const s = seat(msg.seatId);
        if (!s) throw new Error("Take a seat first.");
        if (!s.present) throw new Error(`${label(s)} is marked absent. Mark them present to act.`);
        const text = msg.t === "act" ? clean(msg.text, MAX_TEXT, true) : "";
        if (msg.t === "act" && !text) return;
        // One pending entry per seat per round: posting again replaces it.
        state.messages = state.messages.filter((m) => !(m.round === state.round && isPending(m) && m.seatId === s.id));
        state.messages.push({
          id: state.nextId++, kind: msg.t, round: state.round, seatId: s.id,
          author: s.player, character: s.character, text, ts: Date.now(),
        });
        if (await this.maybeAutoResolve(state)) return;
        return this.commit(state);
      }

      case "retract": {
        if (isResolving(state)) throw new Error("Too late, the GM is already answering.");
        state.messages = state.messages.filter((m) => !(m.round === state.round && isPending(m) && m.seatId === msg.seatId));
        return this.commit(state);
      }

      case "ooc": {
        const s = seat(msg.seatId);
        const text = clean(msg.text, MAX_TEXT, true);
        if (!s || !text) return;
        state.messages.push({
          id: state.nextId++, kind: "ooc", round: state.round, seatId: s.id,
          author: s.player, character: s.character, text, ts: Date.now(),
        });
        return this.commit(state);
      }

      case "resolve": {
        if (isResolving(state)) return;
        if (!pendingFor(state).length) throw new Error("Nothing to resolve yet. Someone has to act first.");
        return this.resolve(state);
      }

      case "tier": {
        if (msg.tier === "small" || msg.tier === "large") state.tier = msg.tier;
        return this.commit(state);
      }

      case "reset":
        throw new Error("Only the Game Master can end or discard a session, from Settings.");

      default:
        throw new Error("Unknown command.");
    }
  }

  async maybeAutoResolve(state) {
    if (isResolving(state)) return false;
    const present = state.seats.filter((s) => s.present);
    if (!present.length) return false;
    const pending = pendingFor(state);
    const answered = new Set(pending.map((m) => m.seatId));
    if (!pending.length || !present.every((s) => answered.has(s.id))) return false;
    await this.resolve(state);
    return true;
  }

  // ---------------- the GM ----------------

  async resolve(state) {
    state.resolvingSince = Date.now();
    const round = state.round;
    const tier = state.tier;
    await this.commit(state);

    let result;
    try {
      const repo = await loadState(this.env);
      const messages = [
        { role: "system", content: buildSystemPrompt(repo) },
        ...buildConversation(state),
      ];
      const model = tier === "large" ? this.env.MODEL_LARGE : this.env.MODEL;
      result = await callMistral(this.env, model, messages);
      result.model = model;
    } catch (err) {
      const fresh = await this.load();
      fresh.resolvingSince = 0;
      await this.commit(fresh);
      this.broadcastError(`The Weave did not answer: ${err.message}. Your actions are still waiting; press Resolve to try again.`);
      return;
    }

    // Re-read: other commands may have landed while the GM was thinking.
    const fresh = await this.load();
    fresh.messages.push({
      id: fresh.nextId++, kind: "gm", round, text: result.reply, ts: Date.now(),
      model: result.model, usage: result.usage,
    });
    const u = result.usage || {};
    fresh.spend[tier].in += u.prompt_tokens || 0;
    fresh.spend[tier].out += u.completion_tokens || 0;
    // Actions posted during resolution belong to the next round, not this one.
    fresh.round = round + 1;
    for (const m of fresh.messages) {
      if (m.round === round && isPending(m) && m.ts > state.resolvingSince) m.round = round + 1;
    }
    fresh.resolvingSince = 0;
    await this.commit(fresh);
  }

  broadcastError(text) {
    const payload = JSON.stringify({ t: "error", text });
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(payload); } catch {}
    }
  }
}

// Arrivals, departures and presence changes are part of the record: everyone
// sees them, they are archived, and the GM sees them in the round they happened.
function addEvent(state, text, seat) {
  state.messages.push({ id: state.nextId++, kind: "event", round: state.round, seatId: seat?.id, text, ts: Date.now() });
}

function isPending(m) {
  return m.kind === "act" || m.kind === "pass";
}

function pendingFor(state) {
  return state.messages.filter((m) => m.round === state.round && isPending(m));
}

function isResolving(state) {
  return !!state.resolvingSince && Date.now() - state.resolvingSince < STALE_RESOLVE_MS;
}

function label(seat) {
  return seat.character || seat.player;
}

// Rebuild the GM's view of play: each round becomes one "user" turn holding
// every gathered action, followed by the GM's reply as the "assistant" turn.
function buildConversation(state) {
  const rounds = [];
  for (let r = Math.max(1, state.round - GM_HISTORY_ROUNDS); r <= state.round; r++) rounds.push(r);

  const present = state.seats.filter((s) => s.present).map(label);
  const absent = state.seats.filter((s) => !s.present).map(label);

  const out = [];
  for (const r of rounds) {
    const acts = state.messages.filter((m) => m.round === r && (isPending(m) || m.kind === "event"));
    const gm = state.messages.find((m) => m.round === r && m.kind === "gm");
    if (!acts.some(isPending) && !gm) continue;

    const lines = acts.map((m) => {
      if (m.kind === "event") return `- (at the table) ${m.text}`;
      const who = m.character ? `${m.character} (played by ${m.author})` : m.author;
      return m.kind === "pass" ? `- ${who} passes this beat.` : `- ${who}: ${m.text}`;
    });
    let content = `ROUND ${r}: actions gathered from the table:\n${lines.join("\n") || "- (no actions)"}`;
    if (r === state.round) {
      content += `\n\nAt the table now: ${present.join(", ") || "nobody"}.` +
        (absent.length ? ` Absent (elsewhere, do not narrate them acting): ${absent.join(", ")}.` : "");
    }
    out.push({ role: "user", content });
    if (gm) out.push({ role: "assistant", content: gm.text });
  }
  return out;
}

function buildSystemPrompt(state) {
  const logTail = state.log.length > LOG_TAIL_CHARS
    ? "[...earlier entries omitted...]\n" + state.log.slice(-LOG_TAIL_CHARS)
    : state.log;

  return `You are the Game Master of EIDHOLM, a techfantasy text RPG played in a browser by a group sharing one scene.

## How you run the game
- Tone: mythic in scale, grim in texture. Between grimdark and epic. Heroes exist, but the world does not owe them victories.
- Several players share one scene. Each turn you receive the actions of every present character, gathered together. Resolve them together in one coherent beat: actions can collide, help, or undercut each other. Give each acting character a consequence.
- A character who passes simply lets the moment play out; do not invent actions for them.
- Characters marked absent are elsewhere. Never narrate them acting or speaking.
- Second person plural when addressing the group, by character name when addressing one. Present tense. Vivid but economical: usually 2 to 5 paragraphs, then hand control back with a situation the table can act on.
- Never decide what player characters think, say, or choose.
- Players may join or leave mid-session; "(at the table)" lines tell you when. Weave arrivals and departures into the fiction plausibly.
- If the party roster is empty, the table is in character creation: help each player build a character that fits the canon, one question at a time, and summarise each finished character clearly so it can be written to the party file.
- If a player is seated without a character, or their character is not in the PARTY file yet, help them create one alongside the scene, without stalling the others.
- NPCs have their own agendas, faiths and fears. Minds of glass are people, not appliances.
- Stay inside the canon below. Do not contradict it. You may invent local detail (names, streets, minor NPCs) that fits it.
- THE RIM AND THE FROZEN ARCHIVE ARE DELIBERATELY UNDEFINED. Never explain what the Archive is, who or what records at the pole, or why it deletes. Rumour, dread and contradiction only. No revelations, ever.
- The rules system is unfinished (see RULES). When an outcome is uncertain and matters, say so, propose how it could be resolved, and mark any mechanic you introduce as [PROVISIONAL] so the table can adopt or reject it.

## CANON (settled; do not alter)
${state.canon}

## RULES (draft, open for design)
${state.rules || "(none yet)"}

## PARTY (live state)
${state.party || "(empty roster)"}

## CAMPAIGN LOG (most recent)
${logTail || "(no sessions yet)"}`;
}

async function callMistral(env, model, messages) {
  const res = await fetch(env.MISTRAL_URL || "https://api.mistral.ai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.MISTRAL_API_KEY}` },
    body: JSON.stringify({ model, temperature: 0.8, max_tokens: 1000, messages }),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    throw new Error(`Mistral returned ${res.status}${detail ? ` (${detail})` : ""}`);
  }
  const data = await res.json();
  const reply = data?.choices?.[0]?.message?.content;
  if (!reply) throw new Error("Mistral sent an empty reply");
  return { reply, usage: data.usage || null };
}

// ======================================================================
// The bouncer
// ======================================================================
//
// One tiny Durable Object per connection (keyed by IP). It remembers wrong
// guesses for each gate separately; after MAX_FAILS inside FAIL_WINDOW_MS the
// gate is shut for LOCKOUT_MS, during which passwords aren't even checked.
// A correct password clears that gate's record.

export class Bouncer extends DurableObject {
  async status(gate) {
    const r = (await this.ctx.storage.get(gate)) || {};
    const now = Date.now();
    if (r.lockedUntil && r.lockedUntil > now) return { locked: true, retryAfter: Math.ceil((r.lockedUntil - now) / 1000) };
    return { locked: false, fails: r.fails && now - r.since < FAIL_WINDOW_MS ? r.fails : 0 };
  }

  async fail(gate) {
    const now = Date.now();
    let r = (await this.ctx.storage.get(gate)) || {};
    if (!r.since || now - r.since >= FAIL_WINDOW_MS || (r.lockedUntil && r.lockedUntil <= now)) r = { fails: 0, since: now };
    r.fails += 1;
    if (r.fails >= MAX_FAILS) r.lockedUntil = now + LOCKOUT_MS;
    await this.ctx.storage.put(gate, r);
    // Forget this connection entirely once nothing is left to remember.
    await this.ctx.storage.setAlarm(now + Math.max(FAIL_WINDOW_MS, LOCKOUT_MS) + 60_000);
    return r.lockedUntil ? { locked: true, retryAfter: Math.ceil(LOCKOUT_MS / 1000) } : { locked: false };
  }

  async clear(gate) {
    await this.ctx.storage.delete(gate);
  }

  async alarm() {
    await this.ctx.storage.deleteAll();
  }
}

async function guarded(bouncer, gate, check) {
  const st = await bouncer.status(gate);
  if (st.locked) return st;
  if (await check()) {
    if (st.fails) await bouncer.clear(gate);
    return { ok: true };
  }
  const after = await bouncer.fail(gate);
  return after.locked ? after : { ok: false };
}

function lockedOut(retryAfter) {
  const minutes = Math.max(1, Math.ceil(retryAfter / 60));
  return new Response(JSON.stringify({
    error: `Too many wrong attempts. This door stays shut for ${minutes} more minute${minutes === 1 ? "" : "s"}.`,
    retryAfter,
  }), {
    status: 429,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Retry-After": String(retryAfter) },
  });
}

function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For")?.split(",")[0].trim() || "unknown";
}

// ======================================================================
// Gate and tickets
// ======================================================================

async function passwordMatches(given, expected) {
  if (!given || !expected) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

async function hmac(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function makeTicket(secret) {
  const exp = Date.now() + TICKET_TTL_MS;
  return `${exp}.${await hmac(secret, "ticket:" + exp)}`;
}

async function verifyTicket(ticket, secret) {
  if (!ticket || !secret) return false;
  const [exp, sig] = ticket.split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const expected = await hmac(secret, "ticket:" + exp);
  const enc = new TextEncoder();
  const a = enc.encode(sig), b = enc.encode(expected);
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

// ======================================================================
// Repo state
// ======================================================================

async function loadState(env) {
  const entries = await Promise.all(
    Object.entries(STATE_FILES).map(async ([key, path]) => [key, await fetchRepoFile(env, path)])
  );
  return Object.fromEntries(entries);
}

async function fetchRepoFile(env, path) {
  const base = env.GITHUB_API || "https://api.github.com";
  const apiUrl = `${base}/repos/${env.GITHUB_REPO}/contents/${path}?ref=${env.GITHUB_BRANCH}`;
  const cache = caches.default;
  const cacheKey = new Request(`https://eidholm-state.cache/${env.GITHUB_BRANCH}/${path}`);

  const hit = await cache.match(cacheKey);
  if (hit) return hit.text();

  const res = await fetch(apiUrl, {
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github.raw+json",
      "User-Agent": "eidholm-worker",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (res.status === 404) return "";
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);

  const text = await res.text();
  await cache.put(cacheKey, new Response(text, { headers: { "Cache-Control": `max-age=${STATE_CACHE_SECONDS}` } }));
  return text;
}

// ======================================================================
// Helpers
// ======================================================================

function clean(value, max, multiline = false) {
  if (typeof value !== "string") return "";
  let v = value.replace(/\r/g, "");
  if (!multiline) v = v.replace(/\s+/g, " ");
  return v.trim().slice(0, max);
}

function send(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch {}
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
