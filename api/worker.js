// Eidholm RPG: Cloudflare Worker
// Password gate + proxy to Mistral. Serves the web client from ../web as static assets.
//
// Secrets (wrangler secret put): GAME_PASSWORD, MISTRAL_API_KEY, GITHUB_TOKEN
// Vars (wrangler.toml):          MODEL, MODEL_LARGE, GITHUB_REPO, GITHUB_BRANCH

const MISTRAL_URL = "https://api.mistral.ai/v1/chat/completions";
const STATE_FILES = {
  canon: "world/worldbuilding.md",
  rules: "rules/resolution.md",
  party: "characters/party.json",
  log: "campaign/log.md",
};
const LOG_TAIL_CHARS = 4000;
const MAX_HISTORY = 24;          // messages kept from the client per request
const MAX_MESSAGE_CHARS = 4000;  // per player message
const STATE_CACHE_SECONDS = 60;  // how long fetched repo state is reused

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

      // 1. The gate. Nothing below this line runs on a wrong password,
      //    so a stranger can never spend a single token.
      const ok = await passwordMatches(request.headers.get("X-Game-Password"), env.GAME_PASSWORD);
      if (!ok) return json({ error: "The gate does not open." }, 401);

      if (url.pathname === "/api/check") return json({ ok: true });
      if (url.pathname === "/api/chat") return handleChat(request, env);
      return json({ error: "Not found" }, 404);
    }

    // Everything else is the static client (index.html etc.)
    return env.ASSETS.fetch(request);
  },
};

async function handleChat(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Bad JSON" }, 400);
  }

  const history = sanitizeHistory(body.messages);
  if (!history.length || history[history.length - 1].role !== "user") {
    return json({ error: "Last message must be from the player." }, 400);
  }

  const model = body.tier === "large" ? env.MODEL_LARGE : env.MODEL;

  // 2. Live state from the private repo.
  let state;
  try {
    state = await loadState(env);
  } catch (err) {
    return json({ error: `Could not read game state from GitHub: ${err.message}` }, 502);
  }

  // 3. System prompt: static canon first so the prefix stays identical
  //    across turns (cache-friendly), live state after it.
  const system = buildSystemPrompt(state);

  // 4. Mistral.
  const res = await fetch(MISTRAL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.MISTRAL_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.8,
      max_tokens: 1000,
      messages: [{ role: "system", content: system }, ...history],
    }),
  });

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 500);
    return json({ error: `Mistral returned ${res.status}`, detail }, 502);
  }

  const data = await res.json();
  const reply = data?.choices?.[0]?.message?.content ?? "";

  // 5. Back to the client.
  return json({ reply, usage: data.usage ?? null, model });
}

// ---------- gate ----------

async function passwordMatches(given, expected) {
  if (!given || !expected) return false;
  // Hash both sides so the comparison is fixed-length and constant-time.
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

// ---------- state ----------

async function loadState(env) {
  const entries = await Promise.all(
    Object.entries(STATE_FILES).map(async ([key, path]) => [key, await fetchRepoFile(env, path)])
  );
  return Object.fromEntries(entries);
}

async function fetchRepoFile(env, path) {
  const apiUrl = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}?ref=${env.GITHUB_BRANCH}`;
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
  await cache.put(
    cacheKey,
    new Response(text, { headers: { "Cache-Control": `max-age=${STATE_CACHE_SECONDS}` } })
  );
  return text;
}

// ---------- prompt ----------

function buildSystemPrompt(state) {
  const logTail = state.log.length > LOG_TAIL_CHARS
    ? "[...earlier entries omitted...]\n" + state.log.slice(-LOG_TAIL_CHARS)
    : state.log;

  return `You are the Game Master of EIDHOLM, a techfantasy text RPG played in a browser.

## How you run the game
- Tone: mythic in scale, grim in texture. Between grimdark and epic. Heroes exist, but the world does not owe them victories.
- Second person, present tense, for the player's experience. Vivid but economical: usually 2 to 5 paragraphs, then hand control back.
- End most turns with a clear situation the player can act on. Never decide what player characters think, say, or choose.
- NPCs have their own agendas, faiths and fears. Minds of glass are people, not appliances.
- Stay inside the canon below. Do not contradict it. You may invent local detail (names, streets, minor NPCs) that fits it.
- THE RIM AND THE FROZEN ARCHIVE ARE DELIBERATELY UNDEFINED. Never explain what the Archive is, who or what records at the pole, or why it deletes. Rumour, dread and contradiction only. No revelations, ever.
- The rules system is unfinished (see RULES). When an outcome is uncertain and matters, say so, propose how it could be resolved, and mark any mechanic you introduce as [PROVISIONAL] so the table can adopt or reject it.
- Out-of-character questions from the player (prefixed with "OOC:") get a short, direct out-of-character answer.

## CANON (settled; do not alter)
${state.canon}

## RULES (draft, open for design)
${state.rules || "(none yet)"}

## PARTY (live state)
${state.party || "(empty roster)"}

## CAMPAIGN LOG (most recent)
${logTail || "(no sessions yet)"}`;
}

// ---------- helpers ----------

function sanitizeHistory(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-MAX_HISTORY)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE_CHARS) }));
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
