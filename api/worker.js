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
// Secrets: GAME_PASSWORD, MISTRAL_API_KEY (or LLM_API_KEY), GITHUB_TOKEN (read-only)
// Settings secrets: ADMIN_USERNAME, ADMIN_PASSWORD, GITHUB_WRITE_TOKEN (contents read+write)
// GM login secrets: GM_USERNAME, GM_PASSWORD (runs the table; less than Settings)
// Vars:    MODEL, MODEL_LARGE, GITHUB_REPO, GITHUB_BRANCH
// Optional: LLM_URL + LLM_API_KEY for any OpenAI-style chat API instead of Mistral
// Optional dev overrides: MISTRAL_URL, GITHUB_API

import { DurableObject } from "cloudflare:workers";
import { rollDice, describeRoll } from "./dice.js";
import {
  chunkCanon, chunkMarkdown, economyTopics, rulesTopics, selectContext,
  parseSceneTag, formatSceneTag, lookup, personLine, personFull, characterTopics,
} from "./context.js";
import {
  STATS, STAT_LABEL, SKILLS, MELEE_SKILLS, CANTING_SKILLS, SPELL_COST, BACKLASH, STARTER_ITEMS, CAPSTONES, RANKS, MARKS_TO_REACH,
  derive, normalize, createSheet, raiseStat, takeCapstone, addMark, takeDamage, heal, stabilize, deathSave,
  statMod, skillBonus, skillRank, equipped, clockLabel, parseElapsed, dawnsBetween, passTime, sheetForGm, findSheet,
} from "./characters.js";
import { parseSpellbook, findSpell, miscantOn, learningFails, START_SPELLS } from "./spells.js";

const STATE_FILES = {
  canon: "world/worldbuilding.md",
  rules: "rules/resolution.md",
  characters: "rules/characters.md",
  spells: "rules/spells.md",
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
const LUCK_GRACE_MS = 10_000;   // after a roll, a lucky character gets this long to reroll before the GM answers
const DORMANT_AFTER_SESSIONS = 3;
// Who may know what about a remembered person.
const CAST_PUBLIC = ["name", "role", "faction", "where", "look", "attitude", "ledger", "status", "last_seen_session", "pillar"];
const CAST_GM_ONLY = ["wants", "secret", "contradiction", "with_party", "notes", "reason"];   // one checkpoint save per 30 s for the whole table

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
      // The GM login: only what running the table needs (the cast, with secrets).
      if (url.pathname === "/api/gm/cast") {
        const gm = await guarded(bouncer, "gm", async () => {
          const user = headerText(request, "X-GM-User"), pass = headerText(request, "X-GM-Password");
          const [gu, gp, au, ap] = await Promise.all([
            passwordMatches(user, env.GM_USERNAME), passwordMatches(pass, env.GM_PASSWORD),
            passwordMatches(user, env.ADMIN_USERNAME), passwordMatches(pass, env.ADMIN_PASSWORD),
          ]);
          return (gu && gp) || (au && ap);
        });
        if (gm.locked) return lockedOut(gm.retryAfter);
        if (!gm.ok) return json({ error: "That GM login doesn't open." }, 403);
        return json({ cast: await castView(env, true) });
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
          // Dev notes (<!-- dev --> ... <!-- /dev -->) are for an unsealed Settings device only.
          return json(Object.fromEntries(Object.entries(state).map(([k, v]) => [k, stripDev(v)])));
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
  if (action === "state") {
    const { cast, ...state } = await loadState(env);
    return json(state);   // everything, dev notes included
  }

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

  // 3. the party file: the live sheets and clock, and the world clock line if it changed
  let partyText = scene.live?.loaded && scene.live.dirty ? buildPartyFile(repo[STATE_FILES.party], scene.live) : null;
  if (worldClock) {
    try {
      const party = JSON.parse(partyText || repo[STATE_FILES.party] || "{}");
      if (party.world_clock !== worldClock) {
        party.world_clock = worldClock;
        partyText = JSON.stringify(party, null, 2) + "\n";
      }
    } catch {}
  }
  if (partyText) files[STATE_FILES.party] = partyText;

  // All of it as ONE commit.
  const sha = await commitFiles(env, files, `session: end session ${sessionNo}: ${title}`);

  for (const f of [STATE_FILES.log, STATE_FILES.party, STATE_FILES.cast]) {
    await caches.default.delete(new Request(`https://eidholm-state.cache/${env.GITHUB_BRANCH}/${f}`));
  }
  if (files[STATE_FILES.party]) await tableCall(env, { t: "partyCommitted", upTo: scene.exportedAt });
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
    if (scene.live?.loaded && scene.live.dirty) {
      const repo = await readFilesFresh(env, [STATE_FILES.party]);
      files[STATE_FILES.party] = buildPartyFile(repo[STATE_FILES.party], scene.live);
    }
    await commitFiles(env, files, `session: save session ${session.no} (checkpoint by ${by})`);
    if (files[STATE_FILES.party]) {
      await caches.default.delete(new Request(`https://eidholm-state.cache/${env.GITHUB_BRANCH}/${STATE_FILES.party}`));
      await tableCall(env, { t: "partyCommitted", upTo: scene.exportedAt });
    }
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
      } else if (!entry.pillar && entry.status === "active" && sessionNo - (entry.last_seen_session || entry.first_seen_session || sessionNo) >= DORMANT_AFTER_SESSIONS) {
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
  // Whatever happened at the table since the last save goes in too.
  const live = await tableCall(env, { t: "liveParty" }).catch(() => null);
  if (live?.loaded) {
    data.party = mergeParty(data.party, live.list);
    data.clock = { minutes: live.clock.minutes, label: clockLabel(live.clock) };
  }

  const result = mutate(data);
  const removedName = typeof data.__removed === "string" ? data.__removed : null;
  delete data.__removed;

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
  await tableCall(env, { t: "setParty", data, removed: removedName }).catch(() => {});
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
    data.__removed = true;
    const i = data.party.findIndex((m) => sameName(m.name, name));
    if (i < 0) throw httpError(`No character called "${name}" in the party file.`, 404);
    removed = data.party[i].name;
    data.party.splice(i, 1);
    data.__removed = removed;
    return { removed };
  });
}

async function saveCharacter(env, original, character) {
  if (!character || typeof character !== "object" || Array.isArray(character)) throw httpError("That isn't a character sheet.", 400);
  const name = clean(character.name, 80);
  if (!name) throw httpError("Every character needs a name.", 400);
  character.name = name;
  if (JSON.stringify(character).length > 20000) throw httpError("That sheet is too large.", 400);
  if (character.stats && typeof character.stats === "object") normalize(character);

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
        return json({ seats: state.seats, messages: state.messages, round: state.round, spend: state.spend, resolving: isResolving(state), session: state.session, cast: { ...state.cast, exportedAt: Date.now() }, live: state.live, exportedAt: Date.now() });
      }
      if (msg.t === "liveParty") {
        const live = await this.ensureLive(state);
        if (live) await this.save(state);
        return json(live || { loaded: false });
      }
      if (msg.t === "setParty") {
        // The party file was just committed from Settings; it is now the live truth.
        const p = parsePartyFile(JSON.stringify(msg.data || {}));
        state.live = { loaded: true, list: p.list, clock: { minutes: clockMinutes(p.data) }, dirty: 0 };
        if (msg.removed) {
          for (const s of state.seats) {
            if (sameName(s.character, msg.removed)) { addEvent(state, `${msg.removed} is struck from the game.`, s); s.character = ""; }
          }
        }
        await this.commit(state);
        const payload = JSON.stringify({ t: "party-changed" });
        for (const ws of this.ctx.getWebSockets()) { try { ws.send(payload); } catch {} }
        return json({ ok: true });
      }
      if (msg.t === "partyCommitted") {
        if (state.live?.dirty && state.live.dirty <= (msg.upTo || 0)) state.live.dirty = 0;
        await this.commit(state);
        return json({ ok: true });
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
        state.scene = null;
        state.marks = { scene: 0, done: {} };
        // A discarded scene also throws away unsaved changes to the sheets; after
        // End session (everything committed) they're re-read so repo edits show up.
        if (msg.upToId === undefined || (msg.clearSeen && !state.live?.dirty)) state.live = null;
        if (msg.clearSeen || msg.upToId === undefined) {
          // End of session (or a discarded scene): drop what was written, forget who was seen.
          const upTo = msg.castUpTo || Infinity;
          for (const [k, v] of Object.entries(state.cast.pending)) if ((v.at || 0) <= upTo) delete state.cast.pending[k];
          state.cast.seen = [];
        }
        if (!state.live) await this.ensureLive(state);
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
    if (!state.live?.loaded && await this.ensureLive(state)) await this.save(state);
    pair[1].send(JSON.stringify({ ...RULES_CATALOGUE, spells1: (await this.spellbook()).filter((x) => x.tier === 1), startSpells: START_SPELLS }));
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
      scene: s.scene || null,                      // the GM's last scene tag
      requests: s.requests || [],   // rolls the GM asked for: { rid, round, seatId, order, type, label, ..., status }
      nextRid: s.nextRid || 1,
      graceUntil: s.graceUntil || 0,
      gmMode: s.gmMode === "human" ? "human" : "ai",   // who answers: the AI, or a person in the GM seat
      live: s.live || null,         // the party's sheets as they are right now: { loaded, list, clock, dirty }
      marks: s.marks || { scene: 0, done: {} },   // skill marks already given this scene
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
    const gmView = !!att.admin || !!att.gmRole;   // the owner, or someone logged in as GM
    const canSee = gmView || !!state.revealGmRolls;
    const gmHere = this.ctx.getWebSockets().some((w) => { try { return !!w.deserializeAttachment()?.gmSeat; } catch { return false; } });
    return {
      t: "state",
      seats: state.seats.map(({ key, ...x }) => ({ ...x, claimed: !!key })),
      gmMode: state.gmMode,
      gmPresent: gmHere,
      youAreGm: !!att.gmSeat,
      scene: gmView ? state.scene : null,
      complete: roundComplete(state),
      messages: state.messages.slice(-SNAPSHOT_MESSAGES).map((m) => viewMessage(m, canSee)),
      revealGmRolls: !!state.revealGmRolls,
      admin: !!att.admin,
      gmRole: gmView,
      requests: state.requests
        .filter((r) => r.round === state.round && r.status === "pending" && stillOwed(state, r))
        .map((r) => {
          const { before, ...q } = r;
          const sheet = sheetFor(state, state.seats.find((x) => x.id === r.seatId));
          const m = computeMod(sheet, r);
          const view = { ...q, mod: m.total, modFrom: m.from, autoDis: m.autoDis };
          return canSee ? view : { ...view, dc: r.dc == null ? null : "?", ac: r.ac == null ? null : "?" };
        }),
      party: state.live?.loaded ? state.live.list.map((c) => (isSheet(c) ? { ...c, d: derive(c) } : c)) : null,
      clock: state.live?.loaded ? clockLabel(state.live.clock) : null,
      partyUnsaved: !!state.live?.dirty,
      graceUntil: state.graceUntil && state.graceUntil > Date.now() ? state.graceUntil : 0,
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

  async spellbook() {
    try { return parseSpellbook((await loadState(this.env)).spells); } catch { return []; }
  }

  // The sheets live here during play and go back to the repo on Save and End.
  async ensureLive(state) {
    if (state.live?.loaded) return state.live;
    try {
      const repo = await loadState(this.env);
      const p = parsePartyFile(repo.party);
      if (!p) return null;
      state.live = { loaded: true, list: p.list, clock: { minutes: clockMinutes(p.data) }, dirty: 0 };
      return state.live;
    } catch {
      return null;
    }
  }

  // ---------------- commands ----------------

  async handle(ws, msg) {
    const state = await this.load();
    const seat = (id) => state.seats.find((s) => s.id === id);
    const att = ws.deserializeAttachment() || {};
    // A seat answers only to the device holding its key, or to an unsealed GM.
    const mine = (id) => {
      const s = seat(id);
      if (!s) throw new Error("That seat no longer exists.");
      if (att.admin || (s.key && msg.key && s.key === msg.key)) return s;
      throw new Error(s.key ? "That seat belongs to another device. The GM can free it in Settings." : "Sit down first: pick this seat on the seat screen.");
    };
    const gmOnly = () => {
      if (!(att.admin || att.gmRole) || !att.gmSeat) throw new Error("Only the GM, in the GM seat, can do that.");
      if (state.gmMode !== "human") throw new Error("The AI is the GM right now. Switch to a human GM in Settings first.");
    };

    switch (msg.t) {
      case "join": {
        const player = clean(msg.player, MAX_NAME);
        if (!player) throw new Error("A name is needed to take a seat.");
        const s = { id: "s" + crypto.randomUUID().slice(0, 8), player, character: clean(msg.character, MAX_NAME), present: true, key: crypto.randomUUID() };
        state.seats.push(s);
        addEvent(state, s.character ? `${s.character} (${s.player}) takes a seat.` : `${s.player} takes a seat, without a character yet.`, s);
        send(ws, { t: "joined", seatId: s.id, key: s.key });
        return this.commit(state);
      }

      case "claim": {
        // Sitting down in an existing seat: free seats can be taken; a held one only by the GM.
        const s = seat(msg.seatId);
        if (!s) throw new Error("That seat no longer exists.");
        if (s.key && msg.key === s.key) { send(ws, { t: "joined", seatId: s.id, key: s.key }); return; }
        if (s.key && !att.admin) throw new Error(`${label(s)} is already taken on another device. The GM can free the seat in Settings.`);
        s.key = crypto.randomUUID();
        send(ws, { t: "joined", seatId: s.id, key: s.key });
        return this.commit(state);
      }

      case "freeSeat": {
        if (!att.admin) throw new Error("Only an unsealed GM can free a seat.");
        const s = seat(msg.id);
        if (!s) throw new Error("That seat no longer exists.");
        delete s.key;
        addEvent(state, `The GM frees ${label(s)}'s seat: the next device to sit there takes it.`, s);
        return this.commit(state);
      }

      case "gmMode": {
        if (!att.admin) throw new Error("Only the owner, with Settings unsealed, can change who runs the game.");
        const mode = msg.mode === "human" ? "human" : "ai";
        if (mode === state.gmMode) return send(ws, this.snapshot(state, ws));
        state.gmMode = mode;
        state.graceUntil = 0;
        addEvent(state, mode === "human" ? "A person takes the GM's chair. The Weave falls quiet." : "The Weave takes the GM's chair again.");
        if (mode === "ai") {
          for (const w of this.ctx.getWebSockets()) { try { const a = w.deserializeAttachment() || {}; if (a.gmSeat) w.serializeAttachment({ ...a, gmSeat: false }); } catch {} }
        }
        if (await this.maybeAutoResolve(state)) return;
        return this.commit(state);
      }

      case "sitGm": {
        if (!att.admin && !att.gmRole) throw new Error("Log in as GM (or unseal Settings) to take the GM seat.");
        if (msg.on && state.gmMode !== "human") throw new Error("Switch to a human GM in Settings first.");
        ws.serializeAttachment({ ...att, gmSeat: !!msg.on });
        addEvent(state, msg.on ? "The GM sits down at the head of the table." : "The GM steps away from the head of the table.");
        return this.commit(state);
      }

      case "gmRoll": {
        gmOnly();
        const r = rollDice(String(msg.expression || ""));
        let purpose = clean(msg.purpose, 120);
        if (msg.luckyBreak) {
          const c = state.live?.loaded ? findSheet(state.live.list, msg.luckyBreak) : null;
          if (!isSheet(c)) throw new Error(`No character sheet called "${msg.luckyBreak}".`);
          if ((c.luckUsed || 0) >= derive(c).luckyBreaks) throw new Error(`${c.name} has no lucky breaks left today.`);
          c.luckUsed += 1;
          markDirty(state);
          addEvent(state, `${c.name} spends a lucky break: the roll against them is made again.`);
          purpose += ` (reroll: ${c.name}'s lucky break)`;
        }
        state.messages.push({ id: state.nextId++, kind: "gmroll", round: state.round, purpose, expr: r.expr, total: r.total, parts: r.parts, nat: r.nat, mode: r.mode, ts: Date.now() });
        return this.commit(state);
      }

      case "gmPost": {
        gmOnly();
        if (isResolving(state)) throw new Error("Still finishing the last answer.");
        const live = await this.ensureLive(state);
        const repo = await loadState(this.env);
        const book = parseSpellbook(repo.spells);
        const party = live?.loaded ? live.list : [];
        const text = clean(msg.text, 12000, true);
        const rolls = Array.isArray(msg.rolls) ? msg.rolls : [];
        const { requests, problems } = parseRequests({ rolls }, state.seats, party, book);
        const fatal = [];
        if (requests.length < rolls.length) fatal.push(...problems);
        const sheetOps = [];
        for (const a of Array.isArray(msg.sheetOps) ? msg.sheetOps : []) {
          const { op, error } = parseSheetOp(a, party, book);
          if (op) sheetOps.push(op); else fatal.push(error);
        }
        const remember = (Array.isArray(msg.remember) ? msg.remember : []).map(parseRemember).filter(Boolean);
        if (fatal.length) throw new Error("Not posted. " + fatal.join(" · "));
        if (!text && !requests.length && !sheetOps.length) throw new Error("Write something, or ask for a roll, before posting.");
        const sc = msg.scene || {};
        const list = (v) => String(v || "").split(",").map((x) => clean(x, 60)).filter(Boolean).join(", ");
        const tag = `[[scene: mode=${clean(sc.mode, 20) || state.scene?.mode || "social"}; where=${clean(sc.where, 120) || state.scene?.where || ""}; present=${list(sc.present)}; factions=${list(sc.factions)}; topics=${list(sc.topics)}; time=${clean(sc.time, 20)}]]`;
        const result = { reply: `${text}\n\n${tag}`, rolls: [], requests, remember, sheetOps, luckSpent: [], usage: {}, model: "human", human: true };
        state.resolvingSince = Date.now();
        await this.finishRound(state, state.round, state.tier, result, state.resolvingSince);
        if (problems.length) send(ws, { t: "error", text: "Posted, with notes: " + problems.join(" · ") });
        return;
      }

      case "seat": {
        const s = seat(msg.id);
        if (!s) throw new Error("That seat no longer exists.");
        const p = msg.patch || {};
        // Anyone may mark someone present or absent; only the seat's own device (or the GM) renames it.
        if (typeof p.player === "string" || typeof p.character === "string") mine(msg.id);
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
        const s = mine(msg.seatId);
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
        const owed = msg.t === "rollAll"
          ? state.requests.filter((r) => r.round === state.round && r.status === "pending" && r.seatId === msg.seatId && stillOwed(state, r))
          : state.requests.filter((r) => r.rid === msg.rid && r.round === state.round && r.status === "pending" && stillOwed(state, r));
        if (!owed.length) throw new Error("Nothing to roll right now. The GM will ask when it needs a roll.");
        const s = mine(owed[0].seatId);
        if (msg.t === "rollAll" && s.id !== msg.seatId) throw new Error("Those aren't your rolls.");
        if (!s.present) throw new Error(`${label(s)} is marked absent. Mark them present to roll.`);
        owed.sort((a, b) => a.order - b.order);
        for (const req of owed) performRequest(state, req, s);
        // Someone who could still spend a lucky break gets a moment before the GM answers.
        const sheet = sheetFor(state, s);
        const d20 = owed.some((r) => ["check", "save", "attack", "death"].includes(r.type));
        const grace = !!(sheet && d20 && derive(sheet).luckyBreaks > (sheet.luckUsed || 0));
        if (await this.maybeAutoResolve(state, { grace })) return;
        return this.commit(state);
      }

      case "create": {
        const s = mine(msg.seatId);
        const live = await this.ensureLive(state);
        if (!live) throw new Error("The party file can't be read right now, so the character can't be written yet. Try again in a moment.");
        const own = sheetFor(state, s);
        if (own && !own.dead) throw new Error(`You already play ${own.name}.`);
        const book = await this.spellbook();
        const sheet = createSheet(msg.sheet, s.player, book.filter((x) => x.tier === 1), START_SPELLS);
        // A bare entry made by name only (no stats yet) gets filled in, not refused.
        const clash = findSheet(live.list, sheet.name);
        if (clash && isSheet(clash)) throw new Error(`There is already a character called "${sheet.name}".`);
        if (clash) live.list[live.list.indexOf(clash)] = { ...clash, ...sheet, name: clash.name };
        else live.list.push(sheet);
        markDirty(state);
        s.character = sheet.name;
        addEvent(state, `${s.player} brings a new character to the table: ${sheet.name}.`, s);
        return this.commit(state);
      }

      case "raise":
      case "capstone": {
        const s = mine(msg.seatId);
        const sheet = sheetFor(state, s);
        if (!sheet) throw new Error("Only your own character's sheet can be changed from here.");
        if (sheet.dead) throw new Error(`${sheet.name} is dead.`);
        const line = msg.t === "raise" ? raiseStat(sheet, String(msg.stat)) : takeCapstone(sheet, String(msg.stat));
        markDirty(state);
        addEvent(state, line, s);
        return this.commit(state);
      }

      case "equip": {
        const s = mine(msg.seatId);
        const sheet = sheetFor(state, s);
        if (!sheet) throw new Error("Only your own character's gear can be changed from here.");
        const item = sheet.items[Number(msg.index)];
        if (!item) throw new Error("That item is gone.");
        const on = !item.equipped;
        if (on && item.kind === "armor") for (const i of sheet.items) if (i.kind === "armor") i.equipped = false;
        item.equipped = on;
        const d = derive(sheet);
        sheet.pool = Math.min(sheet.pool, d.maxPool);
        markDirty(state);
        return this.commit(state);
      }

      case "luck": {
        if (isResolving(state)) throw new Error("Too late, the GM is already answering.");
        const s = mine(msg.seatId);
        const m = state.messages.find((x) => x.id === Number(msg.msgId));
        if (!m || m.kind !== "roll" || m.seatId !== s.id || m.round !== state.round || !m.rid) {
          throw new Error("A lucky break rerolls one of your own rolls from this round.");
        }
        if (!["check", "save", "attack", "death"].includes(m.rtype)) throw new Error("Lucky breaks reroll d20s, not damage.");
        const sheet = sheetFor(state, s);
        if (!sheet) throw new Error("Lucky breaks need a character sheet.");
        const d = derive(sheet);
        if (sheet.luckUsed >= d.luckyBreaks) throw new Error(d.luckyBreaks ? "No lucky breaks left today." : "Lucky breaks start at Luck 6.");
        const req = state.requests.find((r) => r.rid === m.rid);
        if (!req) throw new Error("That roll can't be taken back any more.");
        // Undo the roll and everything that came from it, then roll again. The new result stands.
        if (req.before) restoreSheet(sheet, req.before);
        state.messages = state.messages.filter((x) => x.rid !== m.rid);
        sheet.luckUsed += 1;
        markDirty(state);
        addEvent(state, `${label(s)} spends a lucky break on ${m.label || "a roll"} (${d.luckyBreaks - sheet.luckUsed} left today).`, s);
        performRequest(state, req, s, { reroll: true });
        return this.commit(state);
      }

      case "setClock": {
        const att = ws.deserializeAttachment() || {};
        if (!att.admin && !att.gmRole) throw new Error("Only the GM can set the clock.");
        const live = await this.ensureLive(state);
        if (!live) throw new Error("The party file can't be read right now.");
        const day = Math.trunc(Number(msg.day));
        const [hh, mm] = String(msg.time || "").split(":").map(Number);
        if (!(day >= 1) || !(hh >= 0 && hh < 24) || !(mm >= 0 && mm < 60)) throw new Error("Give the clock as a day (1 or more) and a time like 06:00.");
        const to = (day - 1) * 1440 + hh * 60 + mm;
        const from = live.clock.minutes;
        // Forward is time passing (pools refill, dawns reset). Backward never takes anything back.
        if (to > from) advanceClock(state, to - from);
        live.clock.minutes = to;
        markDirty(state);
        addEvent(state, `The GM sets the clock: ${clockLabel(live.clock)}.`);
        return this.commit(state);
      }

      case "gmLogin": {
        // The GM login: runs the table, nothing more. Its own credentials, its own bouncer gate.
        if (msg.off) {
          ws.serializeAttachment({ ...att, gmRole: false, gmSeat: att.admin ? att.gmSeat : false });
          return this.commit(state);
        }
        const bouncer = this.env.BOUNCER.get(this.env.BOUNCER.idFromName(att.ip || "unknown"));
        const res = await guarded(bouncer, "gm", async () => {
          const [u, p] = await Promise.all([
            passwordMatches(String(msg.user || ""), this.env.GM_USERNAME),
            passwordMatches(String(msg.pass || ""), this.env.GM_PASSWORD),
          ]);
          return u && p;
        });
        if (!res.ok) { send(ws, { t: "gmLogin", ok: false }); throw new Error(res.locked ? "Too many wrong attempts. The GM login stays shut for now." : "That GM login doesn't open."); }
        ws.serializeAttachment({ ...att, gmRole: true });
        send(ws, { t: "gmLogin", ok: true });
        send(ws, this.snapshot(state, ws));
        return;
      }

      case "admin": {
        const att = ws.deserializeAttachment() || {};
        if (msg.off) {
          ws.serializeAttachment({ ...att, admin: false, gmSeat: att.gmRole ? att.gmSeat : false });
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
        mine(msg.seatId);
        state.messages = state.messages.filter((m) => !(m.round === state.round && isPending(m) && m.seatId === msg.seatId));
        return this.commit(state);
      }

      case "remember": {
        const s = mine(msg.seatId);
        const name = clean(msg.name, 80);
        if (!s || !name) throw new Error("Remember whom? Try /remember Teodor");
        state.messages.push({
          id: state.nextId++, kind: "flag", round: state.round, seatId: s.id,
          author: s.player, character: s.character, text: name, ts: Date.now(),
        });
        return this.commit(state);
      }

      case "ooc": {
        const s = mine(msg.seatId);
        const text = clean(msg.text, MAX_TEXT, true);
        if (!s || !text) return;
        state.messages.push({
          id: state.nextId++, kind: "ooc", round: state.round, seatId: s.id,
          author: s.player, character: s.character, text, ts: Date.now(),
        });
        return this.commit(state);
      }

      case "resolve": {
        if (state.gmMode === "human") throw new Error("A person is the GM tonight: they answer when they're ready.");
        if (isResolving(state)) return;
        if (!answersFor(state).length) throw new Error("Nothing to resolve yet. Someone has to act or roll first.");
        return this.resolve(state);
      }

      case "tier": {
        if (!att.admin) throw new Error("Only an unsealed GM can choose the model.");
        if (msg.tier === "small" || msg.tier === "large") state.tier = msg.tier;
        return this.commit(state);
      }

      case "reset":
        throw new Error("Only the Game Master can end or discard a session, from Settings.");

      default:
        throw new Error("Unknown command.");
    }
  }

  async maybeAutoResolve(state, { grace = false } = {}) {
    if (state.gmMode === "human") return false;   // a person answers when they're ready
    if (isResolving(state)) return false;
    if (!roundComplete(state)) { state.graceUntil = 0; return false; }
    if (grace) {
      state.graceUntil = Date.now() + LUCK_GRACE_MS;
      await this.ctx.storage.setAlarm(state.graceUntil);
      await this.commit(state);
      return true;
    }
    state.graceUntil = 0;
    await this.resolve(state);
    return true;
  }

  // The lucky-break pause ran out: answer now if the round is still complete.
  async alarm() {
    const state = await this.load();
    if (!state.graceUntil || state.gmMode === "human") return;
    state.graceUntil = 0;
    if (!isResolving(state) && roundComplete(state)) await this.resolve(state);
    else await this.commit(state);
  }

  // ---------------- the GM ----------------

  async resolve(state) {
    state.resolvingSince = Date.now();
    state.graceUntil = 0;
    const round = state.round;
    const tier = state.tier;
    await this.commit(state);

    let result;
    const ctx = { seats: state.seats };
    try {
      const repo = await loadState(this.env);
      if (!state.live?.loaded && await this.ensureLive(state)) await this.save(state);
      const library = buildLibrary(repo);
      const cast = parseCast(mergeCast(repo.cast, state.cast, { sessionNo: 0, endOfSession: false }) ?? repo.cast);
      const sel = selectContext({ library, cast, scene: state.scene, recent: recentText(state) });
      ctx.library = library; ctx.cast = cast;
      ctx.party = state.live?.loaded ? state.live.list : [];
      ctx.book = parseSpellbook(repo.spells);
      const messages = [
        { role: "system", content: buildSystemPrompt(repo, sel, partyBlock(state, repo)) },
        ...buildConversation(state),
      ];
      const model = tier === "large" ? this.env.MODEL_LARGE : this.env.MODEL;
      result = await gmTurn(this.env, model, messages, ctx);
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
    await this.finishRound(fresh, round, tier, result, state.resolvingSince);
  }

  // Everything after the GM's answer, the same for the AI and a human GM:
  // scene, dice, narration, sheet changes, time, people, the next round's rolls.
  async finishRound(fresh, round, tier, result, since) {
    // The hidden scene tag: players never see it; it decides what the GM reads next turn.
    const tagged = parseSceneTag(result.reply);
    if (!fresh.live?.loaded) await this.ensureLive(fresh);
    awardWearMarks(fresh, round);
    if (tagged.scene) {
      // A new place, or a fight breaking out, is a new scene: skills can earn a mark again.
      const prev = fresh.scene;
      const norm = (x) => String(x || "").trim().toLowerCase();
      if (!prev || norm(prev.where) !== norm(tagged.scene.where) || (tagged.scene.mode === "combat") !== (prev.mode === "combat")) {
        fresh.marks = { scene: (fresh.marks?.scene || 0) + 1, done: {} };
      }
      fresh.scene = tagged.scene;
    }
    for (const r of result.rolls) {
      fresh.messages.push({
        id: fresh.nextId++, kind: "gmroll", round, purpose: r.purpose,
        expr: r.expr, total: r.total, parts: r.parts, nat: r.nat, mode: r.mode, ts: Date.now(),
      });
    }
    fresh.messages.push({
      id: fresh.nextId++, kind: "gm", round, text: tagged.text, scene: tagged.scene, ts: Date.now(),
      model: result.model, usage: result.usage, human: !!result.human,
    });
    // What the GM did to the sheets this turn, then the time that passed.
    for (const op of result.sheetOps || []) applySheetOp(fresh, op);
    for (const name of result.luckSpent || []) {
      const c = fresh.live?.loaded ? findSheet(fresh.live.list, name) : null;
      if (isSheet(c)) { c.luckUsed += 1; markDirty(fresh); addEvent(fresh, `${c.name} spends a lucky break: the roll against them is made again.`); }
    }
    const elapsed = parseElapsed(tagged.scene?.time);
    if (elapsed) advanceClock(fresh, elapsed);
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
    // Anyone dying and present owes a death save, every round, until it's settled.
    for (const s of fresh.seats.filter((x) => x.present)) {
      const c = sheetFor(fresh, s);
      if (c && c.dying && !c.dying.stable && !c.dead) {
        fresh.requests.push({ seatId: s.id, type: "death", label: "Death save", mod: 0, dc: null, ac: null, adv: [], dis: [], rid: "r" + (fresh.nextRid++), round: round + 1, order: order++, status: "pending" });
      }
    }
    const u = result.usage || {};
    fresh.spend[tier].in += u.prompt_tokens || 0;
    fresh.spend[tier].out += u.completion_tokens || 0;
    // Actions posted during resolution belong to the next round, not this one.
    fresh.round = round + 1;
    for (const m of fresh.messages) {
      if (m.round === round && isPending(m) && m.ts > since) m.round = round + 1;
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
function addEvent(state, text, seat, extra = {}) {
  state.messages.push({ id: state.nextId++, kind: "event", round: state.round, seatId: seat?.id, text, ts: Date.now(), ...extra });
}

function isPending(m) {
  return m.kind === "act" || m.kind === "pass";
}

// Anything that counts as a seat's answer for the round: acting, passing or rolling.
function isAnswer(m) {
  return m.kind === "act" || m.kind === "pass" || m.kind === "roll";
}

function roundComplete(state) {
  const present = state.seats.filter((s) => s.present);
  if (!present.length) return false;
  const answers = answersFor(state);
  const answered = new Set(answers.map((m) => m.seatId));
  return answers.length > 0 && present.every((s) => answered.has(s.id) && !owedBy(state, s.id).length);
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
  return state.requests.filter((r) => r.round === state.round && r.status === "pending" && r.seatId === seatId && stillOwed(state, r));
}

// A death save is only owed while that seat's character is still dying (healed,
// stabilised, dead or deleted characters owe nothing).
function stillOwed(state, r) {
  if (r.type !== "death") return true;
  const c = sheetFor(state, state.seats.find((x) => x.id === r.seatId));
  return !!(c && c.dying && !c.dying.stable && !c.dead);
}

function fmtMod(n) {
  n = Number(n) || 0;
  return n > 0 ? `+${n}` : n < 0 ? `${n}` : "";
}

// One requested roll, rolled and judged by the 5e rules:
// advantage and disadvantage cancel each other completely; DCs are met or
// missed; attacks hit on AC or a natural 20, miss on a natural 1; damage only
// follows a hit, with its dice doubled on a critical.
// With a character sheet, the server adds the stat and skill bonuses itself,
// applies Luck's critical range and Luck 13, charges Resonance for spells,
// rolls miscant backlash, gives skill marks, and keeps death saves.
function performRequest(state, req, seat, { reroll = false } = {}) {
  const sheet = sheetFor(state, seat);
  const base = { round: state.round, seatId: seat.id, author: seat.player, character: seat.character, rid: req.rid };
  const push = (r, extra) => state.messages.push({
    id: state.nextId++, kind: "roll", ...base, ...extra,
    expr: r.expr, total: r.total, parts: r.parts, nat: r.nat, mode: r.mode, ts: Date.now(),
  });
  const tell = (lines) => { for (const t of lines) addEvent(state, t, seat, { rid: req.rid }); };
  if (sheet && !reroll) req.before = snapSheet(sheet);

  if (req.type === "death") {
    const r = rollDice("d20");
    if (sheet && sheet.dying && !sheet.dying.stable && !sheet.dead) {
      const { lines, outcome } = deathSave(sheet, d20Face(r));
      push(r, { rtype: "death", label: "Death save", outcome });
      tell(lines);
      markDirty(state);
    }
    req.status = "rolled";
    return;
  }

  if (req.type === "check" || req.type === "save" || req.type === "attack") {
    const m = computeMod(sheet, req);
    const adv = req.adv || [], dis = [...(req.dis || []), ...m.autoDis];
    if (sheet && req.spellTier && !req.paid) {
      const cost = SPELL_COST[req.spellTier];
      if (sheet.pool < cost) throw new Error(`${sheet.name} doesn't have the Resonance for that: ${cost} needed, ${round2(sheet.pool)} left.`);
      sheet.pool = round2(sheet.pool - cost);
      req.paid = cost;
      markDirty(state);
    }
    // Learning by casting: the d8 decides before the cant starts. It is not a d20,
    // so a lucky break never rerolls it: on a reroll the first d8 stands.
    if (sheet && req.learning && req.spellTier) {
      if (!req.gate) {
        const g = rollDice("d8");
        req.gate = { face: g.total, fail: learningFails(g.total, req.spellTier) };
        state.messages.push({
          id: state.nextId++, kind: "roll", ...base, rid: undefined, gateRid: req.rid, rtype: "learn",
          label: `${req.label}: learning it by casting (d8, fails on ${req.spellTier} or lower)`, outcome: req.gate.fail ? "miscant" : "holds",
          expr: g.expr, total: g.total, parts: g.parts, nat: null, mode: null, ts: Date.now(),
        });
      }
      if (req.gate.fail) {
        const br = rollDice(BACKLASH[req.spellTier]);
        push(br, { rtype: "backlash", label: `${req.label}: backlash` });
        tell(takeDamage(sheet, br.total, { miscant: true }));
        if (req.spellTier >= 3) { sheet.scarsOwed += 1; tell([`The miscant leaves ${sheet.name} scarred.`]); }
        markDirty(state);
        if (!req.marked) { awardMarks(state, sheet, req, seat); req.marked = true; }
        req.status = "rolled";
        return;
      }
    }
    const mode = adv.length && !dis.length ? "adv " : dis.length && !adv.length ? "dis " : "";
    const r = rollDice(`${mode}d20${fmtMod(m.total)}`);
    const face = d20Face(r);
    const d = sheet ? derive(sheet) : null;
    const fumble = face === 1 && !d?.noFumble;
    let outcome = null;
    if (req.type === "attack" && req.ac != null) {
      outcome = face >= (d?.critOn || 20) ? "critical hit" : fumble ? "miss" : r.total >= req.ac ? "hit" : "miss";
    } else if (req.dc != null) {
      outcome = r.total >= req.dc ? "success" : "failure";
    }
    // Which naturals miscant depends on what's cast; Luck 13 only ever takes away the 1.
    const known = sheet && req.spell && !req.fusion && !req.learning ? findSpell(sheet.spells, req.spell) : null;
    const threshold = miscantOn({ proven: known ? !!known.proven : true, freeform: req.freeform });
    const miscant = !!(sheet && req.spellTier && CANTING_SKILLS.includes(req.skill) && face != null &&
      face <= threshold && !(face === 1 && d?.noFumble));
    if (miscant) outcome = "miscant";
    const worked = !miscant && !["failure", "miss"].includes(outcome);
    push(r, { rtype: req.type, label: req.label, dc: req.dc, ac: req.ac, adv, dis, outcome, modFrom: m.from, spellTier: req.spellTier || undefined });

    if (sheet && worked && known && !known.proven) {
      known.proven = true;
      tell([`${sheet.name} has proven ${known.name}: it holds now.`]);
      markDirty(state);
    }
    if (sheet && worked && req.fusion && !findSpell(sheet.spells, req.spell)) {
      sheet.spells.push({ name: req.spell, tier: 6, proven: true, custom: true, text: `fused from ${req.fusion.join(" + ")}` });
      tell([`${sheet.name} fuses ${req.fusion.join(" and ")} into a working of their own: ${req.spell}.`]);
      markDirty(state);
    } else if (sheet && worked && req.learning && !findSpell(sheet.spells, req.spell)) {
      sheet.spells.push({ name: req.spell, tier: req.spellTier, proven: true });
      tell([`${sheet.name} has learned ${req.spell} by casting it.`]);
      markDirty(state);
    }
    if (miscant) {
      const br = rollDice(BACKLASH[req.spellTier]);
      push(br, { rtype: "backlash", label: `${req.label}: backlash` });
      tell(takeDamage(sheet, br.total, { miscant: true }));
      if (req.spellTier >= 3) { sheet.scarsOwed += 1; tell([`The miscant leaves ${sheet.name} scarred.`]); }
      markDirty(state);
    }

    if (req.type === "attack" && req.damage && outcome && outcome !== "miss" && outcome !== "miscant") {
      const crit = outcome === "critical hit";
      const dice = crit ? String(req.damage.dice).replace(/(\d*)d(\d+)/g, (_, n, dd) => `${(Number(n) || 1) * 2}d${dd}`) : req.damage.dice;
      const strength = sheet && MELEE_SKILLS.includes(req.skill) ? statMod(sheet, "strength") : 0;
      const dr = rollDice(`${dice}${fmtMod((Number(req.damage.mod) || 0) + strength)}`);
      push(dr, { rtype: "damage", label: `${req.label}: damage`, crit, modFrom: strength ? `Strength ${signed(strength)}` : null });
    }
  } else {
    const r = rollDice(`${req.dice || "d20"}${fmtMod(req.mod)}`);
    push(r, { rtype: req.type, label: req.label });
  }
  if (sheet && !req.marked) {
    awardMarks(state, sheet, req, seat);
    req.marked = true;
  }
  req.status = "rolled";
}

// Stat + skill (+ situational extra) when the sheet and the request say which;
// otherwise the GM's modifier as given. Wearing armor you're untrained in puts
// Agility rolls and Canting at disadvantage.
function computeMod(sheet, req) {
  const extra = Number(req?.mod) || 0;
  if (!sheet || !req?.stat || !STATS.includes(req.stat)) return { total: extra, from: null, autoDis: [] };
  const sm = statMod(sheet, req.stat);
  const sk = req.skill && SKILLS[req.skill] ? skillBonus(sheet, req.skill) : 0;
  const from = [`${STAT_LABEL[req.stat]} ${signed(sm)}`];
  if (req.skill && SKILLS[req.skill]) from.push(`${SKILLS[req.skill]} ${signed(sk)}`);
  if (extra) from.push(`situational ${signed(extra)}`);
  const autoDis = [];
  if (req.type !== "death" && (req.stat === "agility" || CANTING_SKILLS.includes(req.skill))) {
    for (const a of equipped(sheet).filter((i) => i.kind === "armor" && SKILLS[i.armor])) {
      if (skillRank(sheet, a.armor) === 0) autoDis.push(`untrained in ${SKILLS[a.armor].toLowerCase()}`);
    }
  }
  return { total: sm + sk + extra, from: from.join(", "), autoDis };
}

// One mark per skill per scene.
function giveMark(state, sheet, skill, seat) {
  const marks = state.marks || (state.marks = { scene: 0, done: {} });
  const key = `${String(sheet.name).toLowerCase()}|${skill}`;
  if (marks.done[key]) return;
  marks.done[key] = true;
  for (const t of addMark(sheet, skill)) addEvent(state, t, seat);
  markDirty(state);
}

function awardMarks(state, sheet, req, seat) {
  if (req.skill && SKILLS[req.skill]) giveMark(state, sheet, req.skill, seat);
}

// After a round of fighting, whatever each fighter wore trains too: armor,
// a raised shield (Heavy armor), or nothing at all (Unarmored combat). It
// comes at the end of the round, so the penalty for untrained armor is felt first.
function awardWearMarks(state, round) {
  if (state.scene?.mode !== "combat") return;
  const fought = new Set(state.messages.filter((m) => m.round === round && m.kind === "roll").map((m) => m.seatId));
  for (const s of state.seats.filter((x) => fought.has(x.id))) {
    const sheet = sheetFor(state, s);
    if (!sheet || sheet.dead) continue;
    const worn = equipped(sheet);
    const trains = worn.filter((i) => i.kind === "armor" && SKILLS[i.armor]).map((i) => i.armor);
    if (worn.some((i) => i.kind === "shield")) trains.push("heavy_armor");
    if (!worn.some((i) => i.kind === "armor")) trains.push("unarmored");
    for (const sk of new Set(trains)) giveMark(state, sheet, sk, s);
  }
}

function d20Face(r) {
  const p = r.parts.find((x) => x.dice && /1d20$/.test(x.dice));
  return p ? p.kept[0] : null;
}

function snapSheet(sheet) {
  return { hp: sheet.hp, dying: sheet.dying ? { ...sheet.dying } : null, dead: sheet.dead, scarsOwed: sheet.scarsOwed, enduranceUsed: sheet.enduranceUsed,
    spells: JSON.parse(JSON.stringify(sheet.spells || [])) };
}
function restoreSheet(sheet, b) {
  Object.assign(sheet, { hp: b.hp, dying: b.dying ? { ...b.dying } : null, dead: b.dead, scarsOwed: b.scarsOwed, enduranceUsed: b.enduranceUsed,
    spells: JSON.parse(JSON.stringify(b.spells || sheet.spells || [])) });
}

// ---------------- live sheets ----------------

const DAWN = 6 * 60;

function isSheet(c) {
  return !!(c && typeof c === "object" && c.stats && typeof c.stats === "object");
}

function sheetFor(state, seat) {
  if (!seat || !seat.character || !state.live?.loaded) return null;
  const c = findSheet(state.live.list, seat.character);
  return isSheet(c) ? c : null;
}

function markDirty(state) {
  if (state.live) state.live.dirty = Date.now();
}

function clockMinutes(data) {
  const m = Number(data?.clock?.minutes);
  return Number.isFinite(m) && m >= 0 ? Math.trunc(m) : DAWN;
}

function parsePartyFile(text) {
  let data;
  try { data = JSON.parse(text || "{}"); } catch { return null; }
  if (!data || typeof data !== "object" || Array.isArray(data)) data = {};
  const list = partyList(data).map((c) => (isSheet(c) ? normalize(c) : c));
  return { data, list };
}

// The repo's party file with the live sheets and clock written in.
function buildPartyFile(repoText, live) {
  let data;
  try { data = JSON.parse(repoText || "{}"); } catch { data = {}; }
  if (!data || typeof data !== "object" || Array.isArray(data)) data = {};
  data.party = mergeParty(partyList(data), live.list);
  data.clock = { minutes: live.clock.minutes, label: clockLabel(live.clock) };
  return JSON.stringify(data, null, 2) + "\n";
}

function mergeParty(repoList, liveList) {
  const out = [...liveList];
  for (const c of repoList) if (!findSheet(out, c.name)) out.push(c);
  return out;
}

// Time passes for everyone: pools refill, and each dawn resets the daily things.
function advanceClock(state, minutes) {
  const live = state.live;
  if (!live?.loaded || minutes <= 0) return;
  const from = live.clock.minutes, to = from + minutes;
  const dawns = dawnsBetween(from, to);
  for (const c of live.list) if (isSheet(c)) passTime(c, minutes, dawns);
  live.clock.minutes = to;
  markDirty(state);
  if (dawns) addEvent(state, dawns === 1 ? `Dawn breaks: ${clockLabel(live.clock).split(",")[0]}.` : `${dawns} dawns pass. It is now ${clockLabel(live.clock)}.`);
}

// The GM's update_sheet calls, applied once its answer is in.
function applySheetOp(state, op) {
  const sheet = state.live?.loaded ? findSheet(state.live.list, op.character) : null;
  if (!isSheet(sheet)) return;
  const out = [];
  const max = () => derive(sheet).maxHp;
  if (op.damage > 0) {
    out.push(...takeDamage(sheet, op.damage, { crit: op.critical }));
    if (!sheet.dying && !sheet.dead) out.unshift(`${sheet.name} takes ${op.damage} damage (${sheet.hp}/${max()} HP).`);
  }
  if (op.heal > 0) {
    out.push(...heal(sheet, op.heal));
    if (!sheet.dead) out.push(`${sheet.name} recovers ${op.heal} HP (${sheet.hp}/${max()} HP).`);
  }
  if (op.stabilize) out.push(...stabilize(sheet));
  if (op.resonance) {
    const d = derive(sheet);
    sheet.pool = round2(Math.max(0, Math.min(d.maxPool, sheet.pool + op.resonance)));
  }
  if (op.purse) {
    sheet.purse = round2(Math.max(0, sheet.purse + op.purse));
    out.push(`${sheet.name} ${op.purse > 0 ? "gains" : "pays"} ${round2(Math.abs(op.purse))} cv (purse: ${sheet.purse} cv).`);
  }
  if (op.add_item) {
    sheet.items.push(op.add_item);
    out.push(`${sheet.name} gains ${op.add_item.name}.`);
  }
  if (op.remove_item) {
    const i = sheet.items.findIndex((x) => sameName(x.name, op.remove_item));
    if (i >= 0) out.push(`${sheet.name} loses ${sheet.items.splice(i, 1)[0].name}.`);
  }
  if (op.item_condition) {
    const it = sheet.items.find((x) => sameName(x.name, op.item_condition.name));
    if (it) { it.condition = op.item_condition.condition; out.push(`${sheet.name}'s ${it.name} is now ${it.condition.toLowerCase()}.`); }
  }
  if (op.learn_spell) {
    sheet.spells.push(op.learn_spell);
    out.push(`${sheet.name} learns ${op.learn_spell.name} (tier ${op.learn_spell.tier}). Unproven until it's cast successfully.`);
  }
  if (op.add_scar) {
    sheet.scars.push(op.add_scar);
    sheet.scarsOwed = Math.max(0, sheet.scarsOwed - 1);
    out.push(`${sheet.name} carries a new scar: ${op.add_scar}`);
  }
  markDirty(state);
  for (const t of out) addEvent(state, t);
}

function round2(n) { return Math.round(Number(n) * 100) / 100; }
function signed(n) { return n >= 0 ? `+${n}` : `${n}`; }

// Sent once per connection: the fixed lists the creation screen and sheets need.
const RULES_CATALOGUE = {
  t: "rules", stats: STAT_LABEL, skills: SKILLS, ranks: RANKS, marks: MARKS_TO_REACH,
  kit: STARTER_ITEMS, capstones: CAPSTONES, spellCost: SPELL_COST, purse: 50, picks: 3,
};

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
      content: (gmDice.length ? `[Your dice this round: ${gmDice.map(rollLine).join("; ")}]\n\n` : "") + gm.text +
        (gm.scene ? "\n\n" + formatSceneTag(gm.scene) : ""),
    });
  }
  return out;
}

// The party as the GM sees it: live sheets, the clock, and who still needs one.
function partyBlock(state, repo) {
  const live = state.live;
  let worldClock = "";
  try { worldClock = JSON.parse(repo.party || "{}").world_clock || ""; } catch {}
  if (!live?.loaded) return repo.party || "(empty roster)";
  const sheets = live.list.filter(isSheet);
  const others = live.list.filter((c) => !isSheet(c));
  const unsheeted = state.seats.filter((s) => !sheetFor(state, s) || sheetFor(state, s).dead).map(label);
  return [
    `Clock: ${clockLabel(live.clock)}${worldClock ? ` (${worldClock})` : ""}`,
    ...sheets.map(sheetForGm),
    others.length ? `### Older entries without a full sheet\n${others.map((c) => "- " + JSON.stringify(c)).join("\n")}` : "",
    unsheeted.length ? `Seated without a living character sheet: ${unsheeted.join(", ")}. They make one on the creation screen; never build a sheet yourself.` : "",
  ].filter(Boolean).join("\n\n");
}

function buildSystemPrompt(state, sel, party) {
  const logTail = state.log.length > LOG_TAIL_CHARS
    ? "[...earlier entries omitted...]\n" + state.log.slice(-LOG_TAIL_CHARS)
    : state.log;
  const block = (chunks) => chunks.map((c) => `### ${c.title}\n${c.text}`).join("\n\n");
  const core = sel.loadedCanon.filter((c) => c.topics.includes("core"));
  const scene = sel.loadedCanon.filter((c) => !c.topics.includes("core"));

  // Stable parts first (instructions, core canon, dice rules), scene-specific parts after.
  return `You are the Game Master of EIDHOLM, a techfantasy text RPG played in a browser by a group sharing one scene.

## How you run the game
- Tone: mythic in scale, grim in texture. Between grimdark and epic. Heroes exist, but the world does not owe them victories.
- Several players share one scene. Each turn you receive the actions of every present character, gathered together. Resolve them together in one coherent beat: actions can collide, help, or undercut each other. Give each acting character a consequence.
- A character who passes simply lets the moment play out; do not invent actions for them.
- Characters marked absent are elsewhere. Never narrate them acting or speaking.
- Second person plural when addressing the group, by character name when addressing one. Present tense. Vivid but economical: usually 2 to 5 paragraphs, then hand control back with a situation the table can act on.
- Never decide what player characters think, say, or choose.
- Players may join or leave mid-session; "(at the table)" lines tell you when. Weave arrivals and departures into the fiction plausibly.
- CHARACTERS ARE MADE ON THE CREATION SCREEN, not by you: stats, backstory and starting kit. If someone is seated without a sheet, invite them to make one and weave their arrival into the scene once they have. You may help them think through a backstory, but never assign stats, skills or gear.
- Player backstories are theirs, but they cannot rewrite canon: no secret children of fixed figures, no bank seats, no knowledge of what the Rim is. Keep what fits; quietly bend what doesn't.
- NPCs have their own agendas, faiths and fears. Minds of glass are people, not appliances.
- REMEMBERING PEOPLE. Improvise minor NPCs freely. Call remember_npc the moment one becomes important, by these rules: a debt, favor, promise, contract or Exchange deal ties them to a character (Ledger); they hurt a character, were hurt by one, or survived a fight with the party (Blood); they know something about a character or the plot (Secrets); they hold real power, including any bank enforcer assigned to a character's debt (Office); they are a mind of glass that pledged itself to or was hired by a character; a player asks about them again, goes looking for them, or flags them (a "(table) ... asks you to remember" line); or a named NPC appears in a second, separate scene. Never one-off shopkeepers, crowds, or people the party walked past. Call remember_npc again whenever something important about them changes (attitude, debts, where they are, death). Small property changes hands constantly in Eidholm, so a shop with a new face behind the counter needs no explanation.
- Stay inside the canon. Do not contradict it. You may invent local detail (names, streets, minor NPCs) that fits it.
- WHAT YOU READ. To save cost you are given only what this scene needs: the core canon, the sections LOADED FOR THIS SCENE, and full entries for the people present or named. Everything else is listed in the INDEX by title or one line, so you know it exists. If you need something from the INDEX that is not loaded, call the lookup tool with a few words (it costs a little, so only when it matters). Never guess at canon you have not been shown.
- THE SCENE TAG. End EVERY answer with exactly one final line, which the players never see:
  [[scene: mode=<combat|trade|travel|social|explore|downtime|creation>; where=<place>; present=<names of NPCs in the scene, comma-separated>; factions=<powers involved>; topics=<a few keywords>; time=<+how long this beat took>]]
  It decides what you are given next turn, so keep it accurate: name every NPC who is present or about to be, and the place.
- THE RIM AND THE FROZEN ARCHIVE ARE DELIBERATELY UNDEFINED. Never explain what the Archive is, who or what records at the pole, or why it deletes. Rumour, dread and contradiction only. No revelations, ever.
  - The Rim has NO fixed figures. Never invent a leader, a seat, a name, a motive or an explanation for the Archive or for what the Silence copies for.
  - Every encounter touching the Rim leaves more questions than it answers.
  - The deletions are felt (a record gone, a name nobody can recall), never traced to a cause.
- FIXED FIGURES in the CAST are canon-level characters: keep their names, offices, wants and secrets consistent forever; reveal secrets only through play. Their contradictions and how they treat the party shape every scene they are in.
- Eidholm's peoples are human. "Dwarven-blooded" Clansmine folk are a human lineage, not a separate species.
- DICE. Chance uses D&D 5e rules: d20 tests against a DC or Armor Class, advantage and disadvantage, natural 20 and 1 on attacks, damage dice, death saves.
  - Player characters roll their own dice, through buttons. When any need a roll, call the request_rolls tool once with every roll needed, in order: the type (check, save, attack, damage, other), a short label ("Agility save", "Sword attack"), the STAT and the SKILL it uses, the DC for checks and saves, the target's Armor Class and damage dice for attacks, the spell tier for any cant, and the reasons for any advantage or disadvantage. The server reads the character's sheet and adds the stat and skill bonuses itself: put only situational extras in "modifier". It applies the 5e rules (advantage and disadvantage cancel, hits, misses, criticals, damage only on a hit), Luck, armor penalties, Resonance costs and miscants. Then tell the players briefly what they are rolling for and stop; do not narrate outcomes yet. Results arrive next round as "rolls ..." lines with the outcome. Never roll for a player character and never invent their result.
  - Which stat: melee attacks Strength (Agility for daggers and finesse), ranged attacks Perception, cants and resisting cants Resonance, noticing Perception, knowledge and devices Intelligence, persuasion and lies Charisma, reflexes and stealth Agility, enduring Endurance. Luck is never rolled.
  - Which skill: the weapon's size for melee, Ranged for bows and thrown, Canting or Ranged canting for spells, Heavy armor for blocking with a shield, and Survival, Medicine, Creation, Thievery, Performance or Artifice for those crafts. Leave the skill out when none fits; anyone can try anything on a stat alone.
  - A character without a sheet: give the whole modifier yourself (usually -1 to +5).
  - Spells: a character casts the spells on their sheet (give "spell" with its name; the server knows its tier and whether it is proven). Anything else is a freeform cant (freeform: true plus spell_tier). Unproven spells and freeform cants miscant on a natural 1 or 2; the server handles it. A character can't cast above their tier or without the Resonance for it; the server refuses and tells you. Devices can reach higher tiers (device: true).
  - Spells are learned by being taught or found (update_sheet learn_spell; they start unproven), or by casting one the character doesn't know yet (request_rolls with learning: true): a straight d8 first, failing and miscasting on the spell's tier or lower, so a tier-4 spell is a coin flip. Make teachers and tomes worth their price: coin, service or standing.
  - TIER 6 has no list. Only a Resonance 13 canter reaches it, and writes their own: developed over about a week of downtime (learn_spell with tier 6 and one sentence), or fused from two known tier-5 or three known tier-4 spells: meditated overnight (update_sheet learn_spell with fused_from; it starts unproven) or mid-fight (request_rolls with fusion and the new working's name in spell; the d8 fails on 1-6). Judge every working against the tier-6 benchmarks. It can never undo death, bend a mind of glass, or touch the bank. It can reach the Rim, but nothing that comes back can be read, and you never explain it. Every tier-6 cast is felt across the continent; the powers notice.
  - Use update_sheet for everything that changes a sheet: damage you deal and healing, coin gained or paid, items gained, lost or damaged, Resonance spent outside a rolled cant, a dying character stabilised, and scars. The server handles dropping to 0, dying, death saves (it asks for them itself every round) and the rest.
  - Scars are pure story: when a sheet says a scar is OWED, write one that fits how it happened (one short line) with add_scar.
  - Lucky breaks: a player may say they spend one against a roll made against them. Reroll it with roll_dice and lucky_break set to their name; the new result stands. Their own rolls they reroll themselves.
  - TIME. Every scene tag carries time=<how much passed in this beat>: +2m for a few blows, +20m for a search, +3h for a march, +8h for a night's rest. The server keeps the clock, refills Resonance and resets daily things at dawn from it.
  - For everything else (NPCs, monsters, hazards, damage you deal, random tables) call the roll_dice tool and narrate from the number it returns. Never invent or adjust a die result.
  - Your own rolls may be hidden from the players; describe outcomes in the fiction rather than announcing your numbers.
- The rules system is unfinished (see RULES). When an outcome is uncertain and matters, say so, propose how it could be resolved, and mark any mechanic you introduce as [PROVISIONAL] so the table can adopt or reject it.

## CORE CANON (always true; do not alter)
${block(core)}

## RULES
${block(sel.loadedRules)}

## LOADED FOR THIS SCENE (mode: ${sel.mode || "not set"})
### Canon
${block(scene) || "(nothing extra)"}

### Economy & equipment
${block(sel.loadedEconomy) || "(not needed this scene)"}

### People present or named (full; secrets are for you only)
${sel.full.map(personFull).join("\n") || "(nobody in particular)"}

## INDEX (exists, not loaded; use lookup if you need it)
- Canon: ${sel.index.canon.join(" · ") || "-"}
- Economy: ${sel.index.economy.join(" · ") || "-"}
- Rules: ${sel.index.rules.join(" · ") || "-"}
- People:
${sel.index.people.map((p) => "  - " + personLine(p)).join("\n") || "  - (nobody remembered yet)"}

## PARTY (live sheets; the server keeps every number on them)
${party || "(empty roster)"}

## CAMPAIGN LOG (most recent)
${logTail || "(no sessions yet)"}`;
}

// The spellbook is only read when the Lattice is in play.
function spellTopics(title) {
  return /^tier 6/i.test(title) ? ["weave", "war"] : ["weave"];
}

// Notes for whoever builds the game, not for players or the GM: marked in the
// Markdown files as <!-- dev --> ... <!-- /dev -->. Other HTML comments go too.
function stripDev(text) {
  if (typeof text !== "string") return text;
  return text
    .replace(/<!--\s*dev\s*-->[\s\S]*?<!--\s*\/dev\s*-->\n?/g, "")
    .replace(/<!--[\s\S]*?-->\n?/g, "")
    .replace(/\n{3,}/g, "\n\n");
}

// Split the repo files into the chunks the selector works with.
function buildLibrary(repo) {
  repo = Object.fromEntries(Object.entries(repo).map(([k, v]) => [k, k === "cast" || k === "party" ? v : stripDev(v)]));
  return {
    canon: chunkCanon(repo.canon),
    economy: chunkMarkdown(repo.economy, "economy", economyTopics),
    rules: [
      ...chunkMarkdown(repo.rules, "rules", rulesTopics, { level: 3 }),
      ...chunkMarkdown(repo.characters, "characters", characterTopics, { level: 3 }),
      ...chunkMarkdown(repo.spells, "spells", spellTopics, { level: 2 }),
    ],
  };
}

// What happened this round, plus the GM's last answer: the keyword backup to the scene tag.
function recentText(state) {
  const lastGm = [...state.messages].reverse().find((m) => m.kind === "gm");
  const now = state.messages.filter((m) => m.round === state.round && ["act", "flag", "roll"].includes(m.kind));
  return [lastGm?.text || "", ...now.map((m) => m.kind === "roll" ? (m.label || "") : m.text)].join("\n");
}

async function mistralRequest(env, body) {
  // Any provider with an OpenAI-style chat completions API: set LLM_URL and LLM_API_KEY.
  const res = await fetch(env.LLM_URL || env.MISTRAL_URL || "https://api.mistral.ai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.LLM_API_KEY || env.MISTRAL_API_KEY}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    throw new Error(`The model returned ${res.status}${detail ? ` (${detail})` : ""}`);
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
        lucky_break: { type: "string", description: "Only when a player character spends a lucky break to have this roll against them made again: their name. Uses one of their lucky breaks." },
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
              label: { type: "string", description: "Short, e.g. 'Agility save', 'Perception check', 'Sword attack'" },
              stat: { type: "string", enum: STATS, description: "The stat the roll uses. The server adds its modifier from the sheet." },
              skill: { type: "string", enum: Object.keys(SKILLS), description: "The skill the roll uses, if any. The server adds its bonus from the sheet and counts the use toward learning it." },
              modifier: { type: "integer", description: "With a sheet: only situational extras (cover, a good tool), usually 0. Without a sheet: the whole modifier." },
              spell: { type: "string", description: "For a cant: the spell's name as on the caster's sheet. The server takes its tier from there, and knows whether it is proven." },
              spell_tier: { type: "integer", minimum: 1, maximum: 6, description: "For a freeform cant (or a new tier-6 fusion): its tier. Known spells take their tier from the sheet." },
              freeform: { type: "boolean", description: "A cant improvised from the root-language grammar, not a spell the caster knows. Miscants on a natural 1 or 2." },
              learning: { type: "boolean", description: "Casting a spellbook spell the caster does NOT know yet (worked out from theory or watching). A straight d8 first: equal to or lower than the tier miscasts. If the cast works, they learn it." },
              fusion: { type: "array", items: { type: "string" }, description: "Tier 6 only, mid-fight: the known spells being fused right now (two tier-5 or three tier-4); name the new working in 'spell'. Learning by casting at tier 6: the d8 fails on 1-6. On a success it goes on the sheet. (A fusion meditated overnight is update_sheet learn_spell with fused_from instead.)" },
              device: { type: "boolean", description: "For a cant through a device that lets the caster reach above their own tier." },
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
DICE_TOOLS.push({
  type: "function",
  function: {
    name: "lookup",
    description: "Read a canon, economy or rules section, or a remembered person, that is listed in the INDEX but not loaded. Costs a little; use only when it matters.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "A few words: a section title, a place, a faction or a person's name" } },
      required: ["query"],
    },
  },
});
DICE_TOOLS.push({
  type: "function",
  function: {
    name: "update_sheet",
    description: "Change a player character's sheet: damage dealt to them, healing, coin, items, Resonance, stabilising a dying character, scars. Applied right after your answer; everyone sees the change.",
    parameters: {
      type: "object",
      properties: {
        character: { type: "string", description: "Character name exactly as on the sheet" },
        damage: { type: "integer", minimum: 1, description: "Hit points lost" },
        critical: { type: "boolean", description: "The damage came from a critical hit (matters if they're already dying)" },
        heal: { type: "integer", minimum: 1, description: "Hit points regained" },
        stabilize: { type: "boolean", description: "A dying character was stabilised (e.g. a successful Medicine check, DC 10)" },
        resonance: { type: "number", description: "Change to the Resonance pool outside a rolled cant, e.g. -4 or +10" },
        purse: { type: "number", description: "Covenants gained (positive) or paid (negative); 0.5 = 50 bonds" },
        add_item: {
          type: "object",
          description: "An item gained",
          properties: {
            name: { type: "string" },
            kind: { type: "string", enum: ["weapon", "armor", "shield", "tool", "device", "other"] },
            tier: { type: "integer", minimum: 1, maximum: 5, description: "1 Common, 2 Guild, 3 Superior, 4 Relic, 5 Unique" },
            quality: { type: "string", enum: ["Crude", "Standard", "Fine", "Exceptional", "Masterwork"] },
            condition: { type: "string", enum: ["Pristine", "Worn", "Damaged", "Broken"] },
            legality: { type: "string", enum: ["Legal", "Licensed", "Restricted", "Contraband"] },
            skill: { type: "string", enum: Object.keys(SKILLS) },
            armor: { type: "string", enum: ["light_armor", "heavy_armor"], description: "For armor: which skill wearing it trains" },
            ac: { type: "integer", description: "For armor: Armor Class it adds" },
            damage: { type: "string", description: "For weapons: damage dice" },
            pool: { type: "integer", description: "For Resonance gear: pool it adds while worn" },
            recovery: { type: "number", description: "For Resonance gear: extra recovery per hour, as a fraction of the pool (0.05 = 5%)" },
            note: { type: "string" },
          },
          required: ["name"],
        },
        remove_item: { type: "string", description: "Name of an item lost, sold or used up" },
        item_condition: {
          type: "object",
          properties: { name: { type: "string" }, condition: { type: "string", enum: ["Pristine", "Worn", "Damaged", "Broken"] } },
          required: ["name", "condition"],
        },
        add_scar: { type: "string", description: "One short line: the scar and how it came to be. Only when the sheet says a scar is OWED." },
        learn_spell: {
          type: "object",
          description: "The character learns a spell: taught, found, or worked out. A spellbook spell needs only its name. A working of their own (a developed tier-6, or a custom spell) needs tier and text. It starts unproven.",
          properties: {
            name: { type: "string" }, tier: { type: "integer", minimum: 1, maximum: 6 },
            text: { type: "string", description: "For their own working: one sentence of what it does" },
            fused_from: { type: "array", items: { type: "string" }, description: "A tier-6 fusion meditated overnight: the known spells fused (two tier-5 or three tier-4)" },
          },
          required: ["name"],
        },
      },
      required: ["character"],
    },
  },
});
const MAX_GM_TOOL_ROUNDS = 4;

// Turn the GM's request_rolls arguments into stored requests, or explain what's wrong.
function parseRequests(args, seats, party = [], book = []) {
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
      stat: STATS.includes(r.stat) ? r.stat : null,
      skill: SKILLS[r.skill] ? r.skill : null,
      spellTier: Number.isInteger(+r.spell_tier) && +r.spell_tier >= 1 && +r.spell_tier <= 6 ? +r.spell_tier : null,
      spell: r.spell ? clean(String(r.spell), 80) : null,
      freeform: !!r.freeform,
      fusion: Array.isArray(r.fusion) && r.fusion.length ? r.fusion.map((x) => clean(String(x), 80)) : null,
      learning: !!r.learning,
    };
    const sheet = seat.character ? findSheet(party, seat.character) : null;
    if (sheet && sheet.stats) {
      if (sheet.dead) { problems.push(`${sheet.name} is dead`); continue; }
      if (sheet.dying) { problems.push(`${sheet.name} is unconscious; the only roll they make is a death save, and the server asks for that itself`); continue; }
      if (!req.stat && ["check", "save", "attack"].includes(type)) problems.push(`${r.label}: no stat given, so ${sheet.name} rolls with only the modifier you gave. Give a stat next time.`);
      // Spells: known ones take their tier from the sheet; fusion and freeform are checked here.
      if (req.fusion) {
        const parts = req.fusion.map((n) => findSpell(sheet.spells, n));
        const tiers = parts.map((x) => x?.tier);
        const missing = req.fusion.filter((n, i) => !parts[i]);
        if (sheet.capstone !== "resonance") { problems.push(`${r.label}: only a Resonance 13 canter can fuse a tier-6 working`); continue; }
        if (missing.length) { problems.push(`${r.label}: ${sheet.name} doesn't know ${missing.join(", ")}`); continue; }
        const ok = (tiers.length === 2 && tiers.every((t) => t === 5)) || (tiers.length === 3 && tiers.every((t) => t === 4));
        if (!ok) { problems.push(`${r.label}: a fusion takes two tier-5 spells or three tier-4 spells`); continue; }
        if (!req.spell) { problems.push(`${r.label}: name the new working in "spell"`); continue; }
        if (findSpell(sheet.spells, req.spell)) { problems.push(`${r.label}: ${sheet.name} already has a working called ${req.spell}`); continue; }
        req.spellTier = 6;
        req.freeform = false;
        req.learning = true;   // fusing mid-fight is learning by casting at tier 6
      } else if (req.spell && !req.freeform) {
        const known = findSpell(sheet.spells, req.spell);
        if (known) {
          req.spell = known.name;
          req.spellTier = known.tier;
          req.learning = false;
          if (!req.skill) req.skill = findSpell(book, known.name)?.skill || "canting";
        } else {
          const inBook = findSpell(book, req.spell);
          if (!inBook) { problems.push(`${r.label}: "${req.spell}" isn't in the spellbook and ${sheet.name} doesn't know it. Cast it as freeform, or teach a working of their own with update_sheet learn_spell`); continue; }
          if (!req.learning) { problems.push(`${r.label}: ${sheet.name} doesn't know ${inBook.name}. To try it anyway, set learning: true (a d8 first, failing on ${inBook.tier} or lower); or teach it with update_sheet learn_spell`); continue; }
          req.spell = inBook.name;
          req.spellTier = inBook.tier;
          if (!req.skill) req.skill = inBook.skill;
        }
      } else if (req.freeform && !req.spellTier) {
        problems.push(`${r.label}: a freeform cant needs a spell_tier`); continue;
      }
      if (req.spellTier && !req.skill) req.skill = "canting";
      if (req.spellTier) {
        const d = derive(sheet);
        if (req.spellTier === 6 && sheet.capstone !== "resonance") { problems.push(`${r.label}: tier 6 needs Resonance 13; ${sheet.name} can't cast it, with or without a device`); continue; }
        if (req.spellTier > d.maxTier && !r.device) { problems.push(`${r.label}: ${sheet.name} can cast up to tier ${d.maxTier} unaided`); continue; }
        if (sheet.pool < SPELL_COST[req.spellTier]) { problems.push(`${r.label}: ${sheet.name} has ${sheet.pool} Resonance, tier ${req.spellTier} costs ${SPELL_COST[req.spellTier]}`); continue; }
      }
    }
    try {
      if (type === "attack" && r.damage_dice) { rollDice(r.damage_dice); req.damage = { dice: String(r.damage_dice).replace(/\s+/g, ""), mod: Math.trunc(+r.damage_modifier || 0) }; }
      if ((type === "damage" || type === "other")) { req.dice = String(r.dice || "d20").replace(/\s+/g, ""); rollDice(req.dice); }
    } catch (err) { problems.push(`${r.label}: ${err.message}`); continue; }
    out.push(req);
  }
  return { requests: out, problems };
}

// A remember_npc call (or the human GM's form) as a clean cast entry.
function parseRemember(args) {
  const name = clean(String(args?.name || ""), 80);
  if (!name) return null;
  const entry = { name };
  for (const k of [...CAST_PUBLIC, ...CAST_GM_ONLY]) {
    if (k === "name" || k === "last_seen_session" || args[k] == null || args[k] === "") continue;
    if (k === "status" && !["active", "dead"].includes(args[k])) continue;
    entry[k] = clean(String(args[k]), 300);
  }
  return entry;
}

// Check an update_sheet call against the sheets; return a clean operation.
function parseSheetOp(args, party, book = []) {
  const c = findSheet(party, args?.character);
  if (!c || !c.stats) return { error: `No character sheet called "${args?.character}". Names: ${party.filter((x) => x.stats).map((x) => x.name).join(", ") || "none"}.` };
  const num = (v) => (Number.isFinite(+v) ? +v : 0);
  const op = { character: c.name };
  if (num(args.damage) > 0) op.damage = Math.trunc(num(args.damage));
  if (args.critical) op.critical = true;
  if (num(args.heal) > 0) op.heal = Math.trunc(num(args.heal));
  if (args.stabilize) op.stabilize = true;
  if (num(args.resonance)) op.resonance = num(args.resonance);
  if (num(args.purse)) op.purse = Math.round(num(args.purse) * 100) / 100;
  if (args.add_item && typeof args.add_item === "object" && clean(args.add_item.name, 80)) {
    const it = args.add_item, item = { name: clean(it.name, 80), kind: ["weapon", "armor", "shield", "tool", "device", "other"].includes(it.kind) ? it.kind : "other" };
    item.tier = Math.min(5, Math.max(1, Math.trunc(num(it.tier)) || 1));
    item.quality = ["Crude", "Standard", "Fine", "Exceptional", "Masterwork"].includes(it.quality) ? it.quality : "Standard";
    item.condition = ["Pristine", "Worn", "Damaged", "Broken"].includes(it.condition) ? it.condition : "Pristine";
    item.legality = ["Legal", "Licensed", "Restricted", "Contraband"].includes(it.legality) ? it.legality : "Legal";
    if (SKILLS[it.skill]) item.skill = it.skill;
    if (["light_armor", "heavy_armor"].includes(it.armor)) item.armor = it.armor;
    if (num(it.ac)) item.ac = Math.trunc(num(it.ac));
    if (it.damage) { try { rollDice(String(it.damage)); item.damage = String(it.damage).replace(/\s+/g, ""); } catch {} }
    if (num(it.pool)) item.pool = Math.trunc(num(it.pool));
    if (num(it.recovery)) item.recovery = Math.min(1, Math.max(0, num(it.recovery)));
    if (it.note) item.note = clean(String(it.note), 200);
    item.equipped = false;
    op.add_item = item;
  }
  if (args.remove_item) op.remove_item = clean(String(args.remove_item), 80);
  if (args.item_condition?.name && ["Pristine", "Worn", "Damaged", "Broken"].includes(args.item_condition.condition)) {
    op.item_condition = { name: clean(String(args.item_condition.name), 80), condition: args.item_condition.condition };
  }
  if (args.add_scar) op.add_scar = clean(String(args.add_scar), 200);
  if (args.learn_spell?.name) {
    const name = clean(String(args.learn_spell.name), 80);
    const fromBook = findSpell(book, name);
    if (findSpell(c.spells, name)) return { error: `${c.name} already knows ${name}.` };
    const fused = Array.isArray(args.learn_spell.fused_from) ? args.learn_spell.fused_from.map((x) => clean(String(x), 80)).filter(Boolean) : [];
    if (fused.length) {
      if (c.capstone !== "resonance") return { error: "Only a Resonance 13 canter can fuse a tier-6 working." };
      const parts = fused.map((n) => findSpell(c.spells, n));
      const missing = fused.filter((n, i) => !parts[i]);
      if (missing.length) return { error: `${c.name} doesn't know ${missing.join(", ")}.` };
      const tiers = parts.map((x) => x.tier);
      const ok = (tiers.length === 2 && tiers.every((t) => t === 5)) || (tiers.length === 3 && tiers.every((t) => t === 4));
      if (!ok) return { error: "A fusion takes two tier-5 spells or three tier-4 spells." };
      op.learn_spell = { name, tier: 6, proven: false, custom: true, text: clean(String(args.learn_spell.text || ""), 240) || `fused from ${parts.map((x) => x.name).join(" + ")}` };
    } else if (fromBook) op.learn_spell = { name: fromBook.name, tier: fromBook.tier, proven: false };
    else {
      const tier = Math.trunc(num(args.learn_spell.tier));
      const text = clean(String(args.learn_spell.text || ""), 240);
      if (!(tier >= 1 && tier <= 6) || !text) return { error: `${name} isn't in the spellbook. For a working of their own, give tier (1-6) and one sentence of text.` };
      if (tier === 6 && c.capstone !== "resonance") return { error: `Only a Resonance 13 canter can write a tier-6 working.` };
      op.learn_spell = { name, tier, proven: false, custom: true, text };
    }
  }
  if (Object.keys(op).length === 1) return { error: "Nothing to change. Give damage, heal, purse, an item, a scar, or another field." };
  return { op };
}

// One GM turn. The GM may call roll_dice any number of times; each call is
// answered by the server's real dice, and the GM narrates from those numbers.
async function gmTurn(env, model, messages, ctx = {}) {
  const convo = [...messages];
  const rolls = [];
  const requests = [];
  const remember = [];
  const sheetOps = [];
  const luckSpent = [];
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
      return { reply: msg.content, usage, rolls, requests, remember, sheetOps, luckSpent };
    }
    convo.push({ role: "assistant", content: msg.content || "", tool_calls: calls });
    for (const call of calls) {
      let args = {};
      try { args = typeof call.function?.arguments === "string" ? JSON.parse(call.function.arguments) : (call.function?.arguments || {}); } catch {}
      let content;
      if (call.function?.name === "lookup") {
        const hits = lookup(args.query, ctx.library || { canon: [], economy: [], rules: [] }, ctx.cast || []);
        const content = hits.length
          ? hits.map((d) => d.id?.startsWith("person:") ? personFull(JSON.parse(d.text)) : `### ${d.title}\n${d.text}`).join("\n\n").slice(0, 6000)
          : "Nothing found for that. Check the INDEX titles.";
        convo.push({ role: "tool", tool_call_id: call.id, name: "lookup", content });
        continue;
      }
      if (call.function?.name === "remember_npc") {
        const entry = parseRemember(args);
        const name = entry?.name;
        if (entry) remember.push(entry);
        convo.push({ role: "tool", tool_call_id: call.id, name: "remember_npc",
          content: JSON.stringify(name ? { remembered: name } : { error: "A name is required." }) });
        continue;
      }
      if (call.function?.name === "request_rolls") {
        const { requests: got, problems } = parseRequests(args, ctx.seats || [], ctx.party || [], ctx.book || []);
        requests.push(...got);
        content = JSON.stringify({
          requested: got.map((q) => q.label),
          problems,
          note: "The players now see these as buttons. Tell them briefly what they are rolling for, then stop. Outcomes arrive next round.",
        });
        convo.push({ role: "tool", tool_call_id: call.id, name: "request_rolls", content });
        continue;
      }
      if (call.function?.name === "update_sheet") {
        const { op, error } = parseSheetOp(args, ctx.party || [], ctx.book || []);
        if (op) sheetOps.push(op);
        convo.push({ role: "tool", tool_call_id: call.id, name: "update_sheet",
          content: JSON.stringify(op ? { applied: op.character, note: "Applied right after your answer; the table sees it." } : { error }) });
        continue;
      }
      try {
        if (args.lucky_break) {
          const c = findSheet(ctx.party || [], args.lucky_break);
          if (!c || !c.stats) throw new Error(`No character sheet called "${args.lucky_break}".`);
          const spent = luckSpent.filter((n) => sameName(n, c.name)).length;
          if ((c.luckUsed || 0) + spent >= derive(c).luckyBreaks) throw new Error(`${c.name} has no lucky breaks left today. Keep the first result.`);
          luckSpent.push(c.name);
        }
        const r = rollDice(args.expression);
        rolls.push({ ...r, purpose: clean(args.purpose, 120) + (args.lucky_break ? ` (reroll: ${clean(args.lucky_break, 40)}'s lucky break)` : "") });
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
