// Eidholm RPG: Cloudflare Worker + shared table (Durable Object)
//
// HTTP (all gated by X-Game-Password):
//   POST /api/check   password check, no side effects
//   POST /api/state   read-only repo state for the Codex (never calls Mistral)
//   POST /api/ticket  short-lived signed ticket for opening the live connection
// WebSocket:
//   GET  /api/ws?ticket=...   live connection to the shared table
//
// Secrets: GAME_PASSWORD, MISTRAL_API_KEY, GITHUB_TOKEN
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
const MAX_STORED_MESSAGES = 600;
const SNAPSHOT_MESSAGES = 300;
const GM_HISTORY_ROUNDS = 12;   // past rounds sent to the GM for continuity
const STALE_RESOLVE_MS = 120_000;

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

      // The gate. Nothing below this line runs on a wrong password.
      const ok = await passwordMatches(request.headers.get("X-Game-Password"), env.GAME_PASSWORD);
      if (!ok) return json({ error: "The gate does not open." }, 401);

      if (url.pathname === "/api/check") return json({ ok: true });
      if (url.pathname === "/api/ticket") return json({ ticket: await makeTicket(env.GAME_PASSWORD) });
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
        send(ws, { t: "joined", seatId: s.id });
        return this.commit(state);
      }

      case "seat": {
        const s = seat(msg.id);
        if (!s) throw new Error("That seat no longer exists.");
        const p = msg.patch || {};
        if (typeof p.present === "boolean") s.present = p.present;
        if (typeof p.player === "string" && clean(p.player, MAX_NAME)) s.player = clean(p.player, MAX_NAME);
        if (typeof p.character === "string") s.character = clean(p.character, MAX_NAME);
        // Marking someone absent can complete a round.
        if (await this.maybeAutoResolve(state)) return;
        return this.commit(state);
      }

      case "removeSeat": {
        state.seats = state.seats.filter((s) => s.id !== msg.id);
        state.messages = state.messages.filter((m) => !(m.round === state.round && isPending(m) && m.seatId === msg.id));
        if (await this.maybeAutoResolve(state)) return;
        return this.commit(state);
      }

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

      case "reset": {
        state.messages = [];
        state.round = 1;
        state.resolvingSince = 0;
        state.spend = { small: { in: 0, out: 0 }, large: { in: 0, out: 0 } };
        return this.commit(state);
      }

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
    const acts = state.messages.filter((m) => m.round === r && isPending(m));
    const gm = state.messages.find((m) => m.round === r && m.kind === "gm");
    if (!acts.length && !gm) continue;

    const lines = acts.map((m) => {
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
- If the party roster is empty, the table is in character creation: help each player build a character that fits the canon, one question at a time, and summarise each finished character clearly so it can be written to the party file.
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
