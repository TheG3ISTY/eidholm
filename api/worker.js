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
import { rollDice, describeRoll } from "./dice.js";

const STATE_FILES = {
  canon: "world/worldbuilding.md",
  rules: "rules/resolution.md",
  economy: "rules/economy.md",
  cast: "campaign/cast.json",
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
const SAVE_COOLDOWN_MS = 30_000;
const DORMANT_AFTER_SESSIONS = 3;
// Who may know what about a remembered person.
const CAST_PUBLIC = ["name", "role", "faction", "where", "look", "attitude", "ledger", "status", "last_seen_session"];
const CAST_GM_ONLY = ["wants", "secret", "notes", "reason"];   // one checkpoint save per 30 s for the whole table

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
      if (url.pathname === "/api/cast") {
        try {
          return json({ cast: await castView(env, false) });
        } catch (err) {
          return json({ error: `Could not read the cast: ${err.message}` }, 502);
        }
      }
      if (url.pathname === "/api/state") {
        try {
          const { cast, ...state } = await loadState(env);   // the cast has secrets; it goes through /api/cast
          return json(state);
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

  if (action === "cast") return json({ cast: await castView(env, true) });

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
    pending: scene.messages.filter((m) => m.round === scene.round && isAnswer(m)).length,
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

  const repo = await readFilesFresh(env, [STATE_FILES.log, STATE_FILES.party, STATE_FILES.cast]);
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

  // 4. the cast: this session's remembered people merged in, everyone seen
  //    marked, anyone unseen for DORMANT_AFTER_SESSIONS sessions goes dormant
  const castJson = mergeCast(repo[STATE_FILES.cast], scene.cast, { sessionNo, endOfSession: true });
  if (castJson !== null) files[STATE_FILES.cast] = castJson;

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

  for (const f of [STATE_FILES.log, STATE_FILES.party, STATE_FILES.cast]) {
    await caches.default.delete(new Request(`https://eidholm-state.cache/${env.GITHUB_BRANCH}/${f}`));
  }
  await tableCall(env, { t: "reset", upToId, castUpTo: scene.cast?.exportedAt || Date.now(), clearSeen: true });
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
    const files = { [session.path]: archive };
    if (Object.keys(scene.cast?.pending || {}).length) {
      const repo = await readFilesFresh(env, [STATE_FILES.cast]);
      const castJson = mergeCast(repo[STATE_FILES.cast], scene.cast, { sessionNo: session.no, endOfSession: false });
      if (castJson !== null) files[STATE_FILES.cast] = castJson;
    }
    await commitFiles(env, files, `session: save session ${session.no} (checkpoint by ${by})`);
    if (files[STATE_FILES.cast]) {
      await caches.default.delete(new Request(`https://eidholm-state.cache/${env.GITHUB_BRANCH}/${STATE_FILES.cast}`));
      await tableCall(env, { t: "castCommitted", upTo: scene.cast.exportedAt });
    }
    await tableCall(env, { t: "markSaved", ok: true, by });
    return { ok: true, sessionNo: session.no, path: session.path };
  } catch (err) {
    await tableCall(env, { t: "markSaved", ok: false }).catch(() => {});
    throw err;
  }
}

// ---------------- the cast ----------------

function parseCast(text) {
  try {
    const data = JSON.parse(text || "{}");
    return Array.isArray(data.cast) ? data.cast.filter((c) => c && c.name) : [];
  } catch {
    return [];
  }
}

const castKey = (name) => String(name || "").trim().toLowerCase();

// Repo cast + this session's pending changes. Returns the new file text,
// or null when nothing would change.
function mergeCast(repoText, live, { sessionNo, endOfSession }) {
  const cast = parseCast(repoText);
  const byKey = new Map(cast.map((c) => [castKey(c.name), c]));
  const pending = live?.pending || {};
  const seen = new Set([...(live?.seen || []), ...Object.keys(pending)]);
  let changed = false;

  for (const [key, change] of Object.entries(pending)) {
    const { at, ...fields } = change;
    let entry = byKey.get(key);
    if (!entry) {
      entry = { name: fields.name, status: "active", first_seen_session: sessionNo };
      cast.push(entry);
      byKey.set(key, entry);
    }
    for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null && v !== "") entry[k] = v;
    changed = true;
  }

  if (endOfSession) {
    for (const entry of cast) {
      if (seen.has(castKey(entry.name))) {
        if (entry.last_seen_session !== sessionNo) { entry.last_seen_session = sessionNo; changed = true; }
        if (entry.status === "dormant") { entry.status = "active"; changed = true; }
      } else if (entry.status === "active" && sessionNo - (entry.last_seen_session || entry.first_seen_session || sessionNo) >= DORMANT_AFTER_SESSIONS) {
        entry.status = "dormant";
        changed = true;
      }
    }
  }
  return changed ? JSON.stringify({ cast }, null, 2) + "\n" : null;
}

// The cast as the table sees it right now: repo + live changes; secrets stripped unless GM.
async function castView(env, gm) {
  const [repo, live] = await Promise.all([loadState(env), tableCall(env, { t: "castPending" })]);
  const merged = parseCast(mergeCast(repo.cast, live, { sessionNo: 0, endOfSession: false }) ?? repo.cast);
  return merged.map((c) => {
    const keep = gm ? [...CAST_PUBLIC, ...CAST_GM_ONLY, "first_seen_session"] : CAST_PUBLIC;
    return Object.fromEntries(Object.entries(c).filter(([k]) => keep.includes(k)));
  });
}

// What the GM reads each turn: active people in full, dormant and dead as one line.
function castPrompt(castText, live) {
  const merged = parseCast(mergeCast(castText, live, { sessionNo: 0, endOfSession: false }) ?? castText);
  if (!merged.length) return "(nobody remembered yet)";
  const line = (c) => `- ${c.name}${c.role ? `, ${c.role}` : ""}${c.where ? ` (${c.where})` : ""}`;
  const active = merged.filter((c) => (c.status || "active") === "active");
  const rest = merged.filter((c) => c.status === "dormant" || c.status === "dead");
  return [
    ...active.map((c) => {
      const f = Object.entries(c).filter(([k]) => !["name", "status", "first_seen_session", "last_seen_session"].includes(k));
      return `- ${c.name}: ` + f.map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join("; ");
    }),
    ...(rest.length ? ["Dormant or dead (one line each):", ...rest.map((c) => `${line(c)} [${c.status}]`)] : []),
  ].join("\n");
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
    if (m.kind === "roll") return `[round ${m.round}] ${who(m)} rolls ${rollLine(m)}`;
    if (m.kind === "flag") return `[round ${m.round}] (table) ${m.author} asks the GM to remember ${m.text}`;
    if (m.kind === "gmroll") return `[round ${m.round}] GM rolls ${rollLine(m)}`;
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
    if (m.kind === "roll") return `🎲 **${who(m)}** rolls ${rollLine(m)} · ${describeRoll(m)}`;
    if (m.kind === "flag") return `> *${m.author} asks the GM to remember ${m.text}.*`;
    if (m.kind === "gmroll") return `🎲 *GM* rolls ${rollLine(m)} · ${describeRoll(m)}`;
    return `> OOC ${m.author}: ${m.text}`;
  }).join("\n\n");
  const pending = scene.messages.filter((m) => m.round === scene.round && isAnswer(m));
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
        return json({ seats: state.seats, messages: state.messages, round: state.round, spend: state.spend, resolving: isResolving(state), session: state.session, cast: { ...state.cast, exportedAt: Date.now() } });
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
        if (msg.clearSeen || msg.upToId === undefined) {
          // End of session (or a discarded scene): drop what was written, forget who was seen.
          const upTo = msg.castUpTo || Infinity;
          for (const [k, v] of Object.entries(state.cast.pending)) if ((v.at || 0) <= upTo) delete state.cast.pending[k];
          state.cast.seen = [];
        }
        await this.commit(state);
        return json({ ok: true });
      }
      if (msg.t === "castPending") {
        return json({ ...state.cast, exportedAt: Date.now() });
      }
      if (msg.t === "castCommitted") {
        // Only drop changes that made it into the commit; later ones stay pending.
        for (const [k, v] of Object.entries(state.cast.pending)) if ((v.at || 0) <= (msg.upTo || 0)) delete state.cast.pending[k];
        await this.save(state);
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
    // Each connection starts as a player. It only sees GM dice after proving
    // the Settings username and password over this same connection.
    pair[1].serializeAttachment({ admin: false, ip: clientIp(request) });
    const state = await this.load();
    pair[1].send(JSON.stringify(this.snapshot(state, pair[1])));
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
      revealGmRolls: !!s.revealGmRolls,
      cast: s.cast || { pending: {}, seen: [] },   // people the GM chose to remember this session
      requests: s.requests || [],   // rolls the GM asked for: { rid, round, seatId, order, type, label, ..., status }
      nextRid: s.nextRid || 1,
    };
  }

  async save(state) {
    if (state.messages.length > MAX_STORED_MESSAGES) {
      state.messages = state.messages.slice(-MAX_STORED_MESSAGES);
    }
    // Only this round's and last round's requests matter; drop the rest.
    state.requests = state.requests.filter((r) => r.round >= state.round - 1);
    await this.ctx.storage.put("table", state);
  }

  // Per connection: GM dice are redacted on the server unless this connection
  // is an unsealed GM or the party toggle is on. Hidden numbers never leave.
  snapshot(state, ws) {
    const att = (ws && ws.deserializeAttachment()) || {};
    const canSee = !!att.admin || !!state.revealGmRolls;
    return {
      t: "state",
      seats: state.seats,
      messages: state.messages.slice(-SNAPSHOT_MESSAGES).map((m) => viewMessage(m, canSee)),
      revealGmRolls: !!state.revealGmRolls,
      admin: !!att.admin,
      requests: state.requests
        .filter((r) => r.round === state.round && r.status === "pending")
        .map((r) => (canSee ? r : { ...r, dc: r.dc == null ? null : "?", ac: r.ac == null ? null : "?" })),
      round: state.round,
      resolving: isResolving(state),
      tier: state.tier,
      spend: state.spend,
      saved: state.session?.savedAt ? { at: state.session.savedAt, by: state.session.savedBy, no: state.session.no } : null,
    };
  }

  broadcast(state) {
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(JSON.stringify(this.snapshot(state, ws))); } catch {}
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
        if (msg.t === "pass" && owedBy(state, s.id).length) throw new Error("You still owe the GM a roll. Roll it first, then pass if you like.");
        // One pending entry per seat per round: posting again replaces it.
        state.messages = state.messages.filter((m) => !(m.round === state.round && isPending(m) && m.seatId === s.id));
        state.messages.push({
          id: state.nextId++, kind: msg.t, round: state.round, seatId: s.id,
          author: s.player, character: s.character, text, ts: Date.now(),
        });
        if (await this.maybeAutoResolve(state)) return;
        return this.commit(state);
      }

      case "roll":
        throw new Error("Rolls come from the GM now: use the buttons on the left, or /roll to roll them all.");

      case "rollRequest":
      case "rollAll": {
        if (isResolving(state)) throw new Error("The GM is answering. Roll when it's done.");
        const mine = msg.t === "rollAll"
          ? state.requests.filter((r) => r.round === state.round && r.status === "pending" && r.seatId === msg.seatId)
          : state.requests.filter((r) => r.rid === msg.rid && r.round === state.round && r.status === "pending");
        if (!mine.length) throw new Error("Nothing to roll right now. The GM will ask when it needs a roll.");
        const s = seat(mine[0].seatId);
        if (!s) throw new Error("That seat no longer exists.");
        if (msg.t === "rollAll" && s.id !== msg.seatId) throw new Error("Those aren't your rolls.");
        if (!s.present) throw new Error(`${label(s)} is marked absent. Mark them present to roll.`);
        mine.sort((a, b) => a.order - b.order);
        for (const req of mine) performRequest(state, req, s);
        if (await this.maybeAutoResolve(state)) return;
        return this.commit(state);
      }

      case "admin": {
        const att = ws.deserializeAttachment() || {};
        if (msg.off) {
          ws.serializeAttachment({ ...att, admin: false });
        } else {
          const bouncer = this.env.BOUNCER.get(this.env.BOUNCER.idFromName(att.ip || "unknown"));
          const res = await guarded(bouncer, "admin", async () => {
            const [u, p] = await Promise.all([
              passwordMatches(String(msg.user || ""), this.env.ADMIN_USERNAME),
              passwordMatches(String(msg.pass || ""), this.env.ADMIN_PASSWORD),
            ]);
            return u && p;
          });
          if (!res.ok) throw new Error(res.locked ? "Too many wrong attempts. Settings stay sealed for now." : "The settings stay sealed.");
          ws.serializeAttachment({ ...att, admin: true });
        }
        send(ws, this.snapshot(state, ws));
        return;
      }

      case "reveal": {
        const att = ws.deserializeAttachment() || {};
        if (!att.admin) throw new Error("Only an unsealed GM can change that.");
        state.revealGmRolls = !!msg.on;
        addEvent(state, state.revealGmRolls ? "The GM's dice are now shown to the table." : "The GM's dice go back behind the screen.");
        return this.commit(state);
      }

      case "retract": {
        if (isResolving(state)) throw new Error("Too late, the GM is already answering.");
        state.messages = state.messages.filter((m) => !(m.round === state.round && isPending(m) && m.seatId === msg.seatId));
        return this.commit(state);
      }

      case "remember": {
        const s = seat(msg.seatId);
        const name = clean(msg.name, 80);
        if (!s || !name) throw new Error("Remember whom? Try /remember Teodor");
        state.messages.push({
          id: state.nextId++, kind: "flag", round: state.round, seatId: s.id,
          author: s.player, character: s.character, text: name, ts: Date.now(),
        });
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
        if (!answersFor(state).length) throw new Error("Nothing to resolve yet. Someone has to act or roll first.");
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
    const answers = answersFor(state);
    const answered = new Set(answers.map((m) => m.seatId));
    const done = (s) => answered.has(s.id) && !owedBy(state, s.id).length;
    if (!answers.length || !present.every(done)) return false;
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
        { role: "system", content: buildSystemPrompt(repo, castPrompt(repo.cast, state.cast)) },
        ...buildConversation(state),
      ];
      const model = tier === "large" ? this.env.MODEL_LARGE : this.env.MODEL;
      result = await gmTurn(this.env, model, messages, { seats: state.seats });
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
    for (const r of result.rolls) {
      fresh.messages.push({
        id: fresh.nextId++, kind: "gmroll", round, purpose: r.purpose,
        expr: r.expr, total: r.total, parts: r.parts, nat: r.nat, mode: r.mode, ts: Date.now(),
      });
    }
    fresh.messages.push({
      id: fresh.nextId++, kind: "gm", round, text: result.reply, ts: Date.now(),
      model: result.model, usage: result.usage,
    });
    for (const r of result.remember || []) {
      const key = castKey(r.name);
      fresh.cast.pending[key] = { ...(fresh.cast.pending[key] || {}), ...r, at: Date.now() };
      if (!fresh.cast.seen.includes(key)) fresh.cast.seen.push(key);
    }
    // Anything still owed from this round lapses; the GM's new requests open the next one.
    for (const r of fresh.requests) if (r.round === round && r.status === "pending") r.status = "lapsed";
    let order = 0;
    for (const q of result.requests || []) {
      const seat = fresh.seats.find((x) => x.id === q.seatId);
      if (!seat) continue;
      fresh.requests.push({ ...q, rid: "r" + (fresh.nextRid++), round: round + 1, order: order++, status: "pending" });
    }
    if (result.requests?.length) {
      const asks = result.requests.map((q) => `${label(fresh.seats.find((x) => x.id === q.seatId) || {})}: ${q.label}`).join(" · ");
      fresh.messages.push({ id: fresh.nextId++, kind: "event", sub: "asks", round: round + 1, text: `The GM asks for rolls. ${asks}`, ts: Date.now() + 1 });
    }
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

// Anything that counts as a seat's answer for the round: acting, passing or rolling.
function isAnswer(m) {
  return m.kind === "act" || m.kind === "pass" || m.kind === "roll";
}

function answersFor(state) {
  return state.messages.filter((m) => m.round === state.round && isAnswer(m));
}

function viewMessage(m, canSee) {
  if (canSee) return m;
  if (m.kind === "gmroll") return { id: m.id, kind: "gmroll", round: m.round, ts: m.ts, hidden: true };
  // Players see whether a roll succeeded, but not the exact DC or Armor Class.
  if (m.kind === "roll" && (m.dc != null || m.ac != null)) {
    return { ...m, dc: m.dc == null ? null : "?", ac: m.ac == null ? null : "?" };
  }
  return m;
}

function rollLine(m) {
  const what = m.label || m.purpose;
  const ctx = [];
  if (m.dc != null) ctx.push(`DC ${m.dc}`);
  if (m.ac != null) ctx.push(`vs AC ${m.ac}`);
  if (m.adv?.length) ctx.push(`advantage: ${m.adv.join(", ")}`);
  if (m.dis?.length) ctx.push(`disadvantage: ${m.dis.join(", ")}`);
  if (m.crit) ctx.push("critical, dice doubled");
  const out = m.outcome ? ` → ${m.outcome.toUpperCase()}` : "";
  return `${what ? what : ""}${ctx.length ? ` (${ctx.join("; ")})` : ""}: ${m.expr} = ${m.total}` +
    `${m.nat === 20 ? " (natural 20)" : m.nat === 1 ? " (natural 1)" : ""}${out}`;
}

// Rolls a seat still owes the GM this round.
function owedBy(state, seatId) {
  return state.requests.filter((r) => r.round === state.round && r.status === "pending" && r.seatId === seatId);
}

function fmtMod(n) {
  n = Number(n) || 0;
  return n > 0 ? `+${n}` : n < 0 ? `${n}` : "";
}

// One requested roll, rolled and judged by the 5e rules:
// advantage and disadvantage cancel each other completely; DCs are met or
// missed; attacks hit on AC or a natural 20, miss on a natural 1; damage only
// follows a hit, with its dice doubled on a critical.
function performRequest(state, req, seat) {
  const base = { round: state.round, seatId: seat.id, author: seat.player, character: seat.character, rid: req.rid };
  const push = (r, extra) => state.messages.push({
    id: state.nextId++, kind: "roll", ...base, ...extra,
    expr: r.expr, total: r.total, parts: r.parts, nat: r.nat, mode: r.mode, ts: Date.now(),
  });

  if (req.type === "check" || req.type === "save" || req.type === "attack") {
    const adv = req.adv || [], dis = req.dis || [];
    const mode = adv.length && !dis.length ? "adv " : dis.length && !adv.length ? "dis " : "";
    const r = rollDice(`${mode}d20${fmtMod(req.mod)}`);
    let outcome = null;
    if (req.type === "attack" && req.ac != null) {
      outcome = r.nat === 20 ? "critical hit" : r.nat === 1 ? "miss" : r.total >= req.ac ? "hit" : "miss";
    } else if (req.dc != null) {
      outcome = r.total >= req.dc ? "success" : "failure";
    }
    push(r, { rtype: req.type, label: req.label, dc: req.dc, ac: req.ac, adv, dis, outcome });

    if (req.type === "attack" && req.damage && outcome && outcome !== "miss") {
      const crit = outcome === "critical hit";
      const dice = crit ? String(req.damage.dice).replace(/(\d*)d(\d+)/g, (_, n, d) => `${(Number(n) || 1) * 2}d${d}`) : req.damage.dice;
      const dr = rollDice(`${dice}${fmtMod(req.damage.mod)}`);
      push(dr, { rtype: "damage", label: `${req.label}: damage`, crit });
    }
  } else {
    const r = rollDice(`${req.dice || "d20"}${fmtMod(req.mod)}`);
    push(r, { rtype: req.type, label: req.label });
  }
  req.status = "rolled";
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
    const acts = state.messages.filter((m) => m.round === r && (isAnswer(m) || m.kind === "flag" || (m.kind === "event" && m.sub !== "asks")));
    const gm = state.messages.find((m) => m.round === r && m.kind === "gm");
    const gmDice = state.messages.filter((m) => m.round === r && m.kind === "gmroll");
    if (!acts.some(isAnswer) && !gm) continue;

    const lines = acts.map((m) => {
      if (m.kind === "event") return `- (at the table) ${m.text}`;
      const who = m.character ? `${m.character} (played by ${m.author})` : m.author;
      if (m.kind === "roll") return `- ${who} rolls ${rollLine(m)}`;
      if (m.kind === "flag") return `- (table) ${m.author} asks you to remember ${m.text}. Flag them with remember_npc.`;
      return m.kind === "pass" ? `- ${who} passes this beat.` : `- ${who}: ${m.text}`;
    });
    const unrolled = state.requests.filter((q) => q.round === r && (q.status === "pending" || q.status === "lapsed"));
    for (const q of unrolled) {
      const sx = state.seats.find((x) => x.id === q.seatId);
      lines.push(`- ${sx ? label(sx) : "someone"} did not roll ${q.label} (still owed).`);
    }
    let content = `ROUND ${r}: actions gathered from the table:\n${lines.join("\n") || "- (no actions)"}`;
    if (r === state.round) {
      content += `\n\nAt the table now: ${present.join(", ") || "nobody"}.` +
        (absent.length ? ` Absent (elsewhere, do not narrate them acting): ${absent.join(", ")}.` : "");
    }
    out.push({ role: "user", content });
    if (gm) out.push({
      role: "assistant",
      content: (gmDice.length ? `[Your dice this round: ${gmDice.map(rollLine).join("; ")}]\n\n` : "") + gm.text,
    });
  }
  return out;
}

function buildSystemPrompt(state, castText = "(nobody remembered yet)") {
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
- REMEMBERING PEOPLE. Improvise minor NPCs freely. Call remember_npc the moment one becomes important, by these rules: a debt, favor, promise, contract or Exchange deal ties them to a character (Ledger); they hurt a character, were hurt by one, or survived a fight with the party (Blood); they know something about a character or the plot (Secrets); they hold real power, including any bank enforcer assigned to a character's debt (Office); they are a mind of glass that pledged itself to or was hired by a character; a player asks about them again, goes looking for them, or flags them (a "(table) ... asks you to remember" line); or a named NPC appears in a second, separate scene. Never one-off shopkeepers, crowds, or people the party walked past. Call remember_npc again whenever something important about them changes (attitude, debts, where they are, death). Small property changes hands constantly in Eidholm, so a shop with a new face behind the counter needs no explanation.
- Stay inside the canon below. Do not contradict it. You may invent local detail (names, streets, minor NPCs) that fits it.
- THE RIM AND THE FROZEN ARCHIVE ARE DELIBERATELY UNDEFINED. Never explain what the Archive is, who or what records at the pole, or why it deletes. Rumour, dread and contradiction only. No revelations, ever.
- DICE. Chance uses D&D 5e rules: d20 tests against a DC or Armor Class, advantage and disadvantage, natural 20 and 1 on attacks, damage dice, death saves.
  - Player characters roll their own dice, through buttons. When any need a roll, call the request_rolls tool once with every roll needed, in order: the type (check, save, attack, damage, other), a short label ("Dexterity save", "Shortsword attack"), the modifier, the DC for checks and saves, the target's Armor Class and damage dice for attacks, and the reasons for any advantage or disadvantage. The server applies the 5e rules itself (advantage and disadvantage cancel, hits, misses, criticals, damage only on a hit). Then tell the players briefly what they are rolling for and stop; do not narrate outcomes yet. Results arrive next round as "rolls ..." lines with the outcome. Never roll for a player character and never invent their result.
  - Until character sheets list modifiers, choose a sensible modifier from the character's description (usually between -1 and +5).
  - For everything else (NPCs, monsters, hazards, damage you deal, random tables) call the roll_dice tool and narrate from the number it returns. Never invent or adjust a die result.
  - Your own rolls may be hidden from the players; describe outcomes in the fiction rather than announcing your numbers.
- The rules system is unfinished (see RULES). When an outcome is uncertain and matters, say so, propose how it could be resolved, and mark any mechanic you introduce as [PROVISIONAL] so the table can adopt or reject it.

## CANON (settled; do not alter)
${state.canon}

## RULES (draft, open for design)
${state.rules || "(none yet)"}

## ECONOMY & EQUIPMENT (designed; use these prices, tiers and item scales)
${state.economy || "(none yet)"}

## CAST (people worth remembering; secrets here are for you only)
${castText}

## PARTY (live state)
${state.party || "(empty roster)"}

## CAMPAIGN LOG (most recent)
${logTail || "(no sessions yet)"}`;
}

async function mistralRequest(env, body) {
  const res = await fetch(env.MISTRAL_URL || "https://api.mistral.ai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.MISTRAL_API_KEY}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    throw new Error(`Mistral returned ${res.status}${detail ? ` (${detail})` : ""}`);
  }
  return res.json();
}

// Plain call, no tools (used for the end-of-session summary).
async function callMistral(env, model, messages) {
  const data = await mistralRequest(env, { model, temperature: 0.8, max_tokens: 1000, messages });
  const reply = data?.choices?.[0]?.message?.content;
  if (!reply) throw new Error("Mistral sent an empty reply");
  return { reply, usage: data.usage || null };
}

const DICE_TOOLS = [{
  type: "function",
  function: {
    name: "roll_dice",
    description: "Roll real dice for anything that is not a player character: NPC and monster attacks, saves and checks, damage, hazards, random tables. Returns the honest result; narrate from it.",
    parameters: {
      type: "object",
      properties: {
        expression: { type: "string", description: "Dice expression, e.g. d20+4, 2d6+3, adv d20+5, dis d20+1, d100" },
        purpose: { type: "string", description: "What the roll is for, e.g. 'goblin attack vs Ysolde (AC 15)'" },
      },
      required: ["expression", "purpose"],
    },
  },
}];
DICE_TOOLS.push({
  type: "function",
  function: {
    name: "request_rolls",
    description: "Ask player characters to roll. Each roll becomes a button for that player; the server rolls honestly and judges the outcome by 5e rules.",
    parameters: {
      type: "object",
      properties: {
        rolls: {
          type: "array",
          items: {
            type: "object",
            properties: {
              character: { type: "string", description: "Character (or player) name exactly as seated" },
              type: { type: "string", enum: ["check", "save", "attack", "damage", "other"] },
              label: { type: "string", description: "Short, e.g. 'Dexterity save', 'Perception', 'Shortsword attack'" },
              modifier: { type: "integer", description: "Total modifier added to the roll" },
              dc: { type: "integer", description: "Difficulty class, for checks and saves" },
              target_ac: { type: "integer", description: "Armor Class of the target, for attacks" },
              damage_dice: { type: "string", description: "For attacks: damage dice rolled on a hit, e.g. '1d6'" },
              damage_modifier: { type: "integer", description: "For attacks: modifier added to damage" },
              dice: { type: "string", description: "For damage or other rolls: the dice, e.g. '2d6' or 'd100'" },
              advantage: { type: "array", items: { type: "string" }, description: "Reasons for advantage, if any" },
              disadvantage: { type: "array", items: { type: "string" }, description: "Reasons for disadvantage, if any" },
            },
            required: ["character", "type", "label"],
          },
        },
      },
      required: ["rolls"],
    },
  },
});
DICE_TOOLS.push({
  type: "function",
  function: {
    name: "remember_npc",
    description: "Flag a non-player character as important, or update one already remembered. Fields you leave out keep their old values.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Their name, exactly as used in the story" },
        role: { type: "string", description: "What they are, e.g. 'fence in the Slag Ward'" },
        faction: { type: "string" },
        where: { type: "string", description: "Where the party can find them" },
        look: { type: "string", description: "One line of appearance and voice" },
        attitude: { type: "string", description: "How they feel about the party: hostile, wary, neutral, friendly, devoted, or a short phrase" },
        ledger: { type: "string", description: "Debts, favors or deals with characters, if any" },
        wants: { type: "string", description: "What they really want (GM only)" },
        secret: { type: "string", description: "What they hide (GM only)" },
        notes: { type: "string", description: "Anything else to keep (GM only)" },
        status: { type: "string", enum: ["active", "dead"], description: "Set 'dead' when they die" },
        reason: { type: "string", description: "Which rule made them important" },
      },
      required: ["name"],
    },
  },
});
const MAX_GM_TOOL_ROUNDS = 4;

// Turn the GM's request_rolls arguments into stored requests, or explain what's wrong.
function parseRequests(args, seats) {
  const out = [], problems = [];
  const names = seats.map((s) => label(s));
  for (const r of Array.isArray(args?.rolls) ? args.rolls : []) {
    const want = String(r.character || "").trim().toLowerCase();
    const seat = seats.find((s) => [s.character, s.player].some((n) => n && n.toLowerCase() === want));
    if (!seat) { problems.push(`no one called "${r.character}" is seated (seated: ${names.join(", ") || "nobody"})`); continue; }
    const type = ["check", "save", "attack", "damage", "other"].includes(r.type) ? r.type : "other";
    const req = {
      seatId: seat.id, type, label: clean(String(r.label || type), 60), mod: Number.isFinite(+r.modifier) ? Math.trunc(+r.modifier) : 0,
      dc: Number.isFinite(+r.dc) && r.dc !== undefined && r.dc !== null ? Math.trunc(+r.dc) : null,
      ac: Number.isFinite(+r.target_ac) && r.target_ac !== undefined && r.target_ac !== null ? Math.trunc(+r.target_ac) : null,
      adv: (Array.isArray(r.advantage) ? r.advantage : []).map((x) => clean(String(x), 60)).filter(Boolean),
      dis: (Array.isArray(r.disadvantage) ? r.disadvantage : []).map((x) => clean(String(x), 60)).filter(Boolean),
      damage: null, dice: null,
    };
    try {
      if (type === "attack" && r.damage_dice) { rollDice(r.damage_dice); req.damage = { dice: String(r.damage_dice).replace(/\s+/g, ""), mod: Math.trunc(+r.damage_modifier || 0) }; }
      if ((type === "damage" || type === "other")) { req.dice = String(r.dice || "d20").replace(/\s+/g, ""); rollDice(req.dice); }
    } catch (err) { problems.push(`${r.label}: ${err.message}`); continue; }
    out.push(req);
  }
  return { requests: out, problems };
}

// One GM turn. The GM may call roll_dice any number of times; each call is
// answered by the server's real dice, and the GM narrates from those numbers.
async function gmTurn(env, model, messages, ctx = {}) {
  const convo = [...messages];
  const rolls = [];
  const requests = [];
  const remember = [];
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  for (let i = 0; i <= MAX_GM_TOOL_ROUNDS; i++) {
    const data = await mistralRequest(env, {
      model, temperature: 0.8, max_tokens: 1000, messages: convo,
      tools: DICE_TOOLS, tool_choice: i < MAX_GM_TOOL_ROUNDS ? "auto" : "none",
    });
    for (const k of Object.keys(usage)) usage[k] += data?.usage?.[k] || 0;
    const msg = data?.choices?.[0]?.message || {};
    const calls = msg.tool_calls || [];
    if (!calls.length) {
      if (!msg.content) throw new Error("Mistral sent an empty reply");
      return { reply: msg.content, usage, rolls, requests, remember };
    }
    convo.push({ role: "assistant", content: msg.content || "", tool_calls: calls });
    for (const call of calls) {
      let args = {};
      try { args = typeof call.function?.arguments === "string" ? JSON.parse(call.function.arguments) : (call.function?.arguments || {}); } catch {}
      let content;
      if (call.function?.name === "remember_npc") {
        const name = clean(String(args.name || ""), 80);
        if (name) {
          const entry = { name };
          for (const k of [...CAST_PUBLIC, ...CAST_GM_ONLY]) {
            if (k === "name" || k === "last_seen_session" || args[k] == null) continue;
            if (k === "status" && !["active", "dead"].includes(args[k])) continue;
            entry[k] = clean(String(args[k]), 300);
          }
          remember.push(entry);
        }
        convo.push({ role: "tool", tool_call_id: call.id, name: "remember_npc",
          content: JSON.stringify(name ? { remembered: name } : { error: "A name is required." }) });
        continue;
      }
      if (call.function?.name === "request_rolls") {
        const { requests: got, problems } = parseRequests(args, ctx.seats || []);
        requests.push(...got);
        content = JSON.stringify({
          requested: got.map((q) => q.label),
          problems,
          note: "The players now see these as buttons. Tell them briefly what they are rolling for, then stop. Outcomes arrive next round.",
        });
        convo.push({ role: "tool", tool_call_id: call.id, name: "request_rolls", content });
        continue;
      }
      try {
        const r = rollDice(args.expression);
        rolls.push({ ...r, purpose: clean(args.purpose, 120) });
        content = JSON.stringify({ expression: r.expr, total: r.total, breakdown: describeRoll(r), natural: r.nat });
      } catch (err) {
        content = JSON.stringify({ error: err.message });
      }
      convo.push({ role: "tool", tool_call_id: call.id, name: call.function?.name || "roll_dice", content });
    }
  }
  throw new Error("The GM kept rolling without answering");
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
