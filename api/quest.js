// The main quest: a spine of 15-25 plot points the GM picks from world/plotpoints.md at the
// start of a story, a Hook first and a Climax last, each with the GM's own note. The players
// never see it; the GM steers toward the current beat and marks it done or skipped.

export const QUEST_MIN = 15, QUEST_MAX = 25;

const KINDS = { H: "hook", T: "thread", R: "turn", C: "climax" };

// "## H1 · The auction lot" and the paragraph under it. Dev notes are already stripped or skipped.
export function parsePlotPoints(md) {
  const text = String(md || "").replace(/<!--[\s\S]*?-->/g, "");
  const out = [];
  const re = /^##\s+([A-Za-z]+\d+)\s*[·:\-–]\s*(.+)$/gm;
  const heads = [...text.matchAll(re)];
  heads.forEach((h, i) => {
    const end = i + 1 < heads.length ? heads[i + 1].index : text.length;
    const body = text.slice(h.index + h[0].length, end).replace(/^#.*$/gm, "").trim().replace(/\s+/g, " ");
    const id = h[1].toUpperCase();
    out.push({ id, title: h[2].trim(), text: body, kind: KINDS[id[0]] || "thread" });
  });
  return out;
}

// The story's enemy, as sent: { name, role, faction, face, want, method, secret, weakness }.
// Invented for this story: never one of the canon's fixed figures (pass their names as canon).
export function villainFromArgs(v, canon = []) {
  const problems = [];
  const f = (k, n) => String(v?.[k] || "").trim().slice(0, n);
  const out = { name: f("name", 60), role: f("role", 120), faction: f("faction", 80), face: f("face", 300), want: f("want", 300), method: f("method", 300), secret: f("secret", 300), weakness: f("weakness", 300) };
  for (const k of ["name", "role", "want", "method", "secret"]) if (!out[k]) problems.push(`The villain needs a ${k}.`);
  const key = (x) => String(x || "").toLowerCase().replace(/[^a-z]/g, "");
  if (out.name && canon.some((c) => key(c) && (key(c) === key(out.name) || key(out.name).includes(key(c)) && key(c).length > 4))) problems.push(`${out.name} is one of the canon's fixed figures. Invent a villain of your own for this story.`);
  return { villain: problems.length ? null : out, problems };
}

// What the planner (or a person) sent, checked against the plot points. Returns { quest } or { problems }.
export function questFromArgs(args, points, { canon = [] } = {}) {
  const problems = [];
  const byId = new Map(points.map((p) => [p.id, p]));
  const raw = Array.isArray(args?.beats) ? args.beats : [];
  const seen = new Set();
  const beats = [];
  for (const b of raw) {
    const id = String(b?.id || "").trim().toUpperCase();
    const p = byId.get(id);
    if (!p) { problems.push(`${id || "(no id)"} is not a plot point.`); continue; }
    if (seen.has(id)) { problems.push(`${id} is used twice.`); continue; }
    seen.add(id);
    beats.push({ id, title: p.title, text: p.text, kind: p.kind, note: String(b?.note || "").trim().slice(0, 400), status: "todo" });
  }
  if (beats.length < QUEST_MIN || beats.length > QUEST_MAX) problems.push(`The quest has ${beats.length} beats; it needs ${QUEST_MIN} to ${QUEST_MAX}.`);
  if (beats.length && beats[0].kind !== "hook") problems.push(`The first beat must be a Hook (H…), not ${beats[0].id}.`);
  if (beats.length && beats.at(-1).kind !== "climax") problems.push(`The last beat must be a Climax (C…), not ${beats.at(-1).id}.`);
  const extra = beats.slice(0, -1).filter((b) => b.kind === "climax").map((b) => b.id);
  if (extra.length) problems.push(`Exactly one Climax, and it is the last beat: take out ${extra.join(", ")} (use a Turn or a Thread there instead).`);
  const { villain, problems: vp } = villainFromArgs(args?.villain, canon);
  problems.push(...vp);
  const revealId = String(args?.villain?.revealed_at || "").trim().toUpperCase();
  let reveal = beats.findIndex((b) => b.id === revealId);
  if (revealId && (reveal <= 0 || reveal === beats.length - 1)) problems.push(`revealed_at must be one of the beats between the first and the last, not ${revealId}.`);
  if (!revealId) { const t = beats.findIndex((b, i) => i > 0 && b.kind === "turn"); reveal = t > 0 ? t : Math.floor(beats.length * 2 / 3); }
  if (beats.some((b) => !b.note)) problems.push(`Every beat needs its own note: where, who, what's at stake.`);
  const title = String(args?.title || "").trim().slice(0, 80);
  const premise = String(args?.premise || "").trim().slice(0, 600);
  if (!title) problems.push("The quest needs a title.");
  if (!premise) problems.push("The quest needs a premise.");
  if (problems.length) return { problems };
  return { quest: { title, premise, villain: { ...villain, revealAt: reveal }, beats, at: 0, builtAt: Date.now(), by: "gm" } };
}

// When the model can't build one: a Hook, a Climax, and a shuffled middle with the Turns late.
export function randomQuest(points, rand = Math.random) {
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const shuffle = (list) => { const a = [...list]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const hooks = points.filter((p) => p.kind === "hook"), climaxes = points.filter((p) => p.kind === "climax");
  const first = pick(hooks), last = pick(climaxes);
  const threads = shuffle(points.filter((p) => p.kind === "thread"));
  const turns = shuffle(points.filter((p) => p.kind === "turn"));
  const size = Math.min(QUEST_MAX, Math.max(QUEST_MIN, 15 + Math.floor(rand() * 4)));
  const middle = size - 2;
  const nTurns = Math.min(turns.length, 2);
  const early = threads.slice(0, middle - nTurns);
  const mid = [...early];
  // Turns land in the back half.
  turns.slice(0, nTurns).forEach((t, i) => mid.splice(Math.floor(mid.length * (0.5 + 0.4 * (i + 1) / (nTurns + 1))), 0, t));
  const beats = [first, ...mid, last].map((p) => ({ id: p.id, title: p.title, text: p.text, kind: p.kind, note: "", status: "todo" }));
  return { title: "The story so far", premise: "Built at random from the plot points; give each beat its shape as you reach it.", villain: null, beats, at: 0, builtAt: Date.now(), by: "random" };
}

// The beat being played now (the first one not done or skipped), or null when it's all played.
export function currentBeat(quest) {
  if (!quest?.beats?.length) return null;
  const i = quest.beats.findIndex((b) => b.status === "todo");
  return i < 0 ? null : { ...quest.beats[i], index: i };
}

// done / skip move the current beat on; back reopens the last one closed.
export function moveQuest(quest, move, { reason = "", note = "" } = {}) {
  if (!quest?.beats?.length) throw new Error("There is no main quest yet.");
  if (move === "none") return { line: "" };
  const cur = currentBeat(quest);
  if (move === "back") {
    const closed = quest.beats.map((b, i) => [b, i]).filter(([b]) => b.status !== "todo").at(-1);
    if (!closed) throw new Error("Nothing to step back to: the quest is at its first beat.");
    closed[0].status = "todo"; delete closed[0].reason;
    quest.at = closed[1];
    return { beat: closed[0], line: `Main quest stepped back to ${closed[0].id} · ${closed[0].title}.` };
  }
  if (!cur) throw new Error("The main quest is already played through.");
  const b = quest.beats[cur.index];
  b.status = move === "skip" ? "skipped" : "done";
  if (reason) b.reason = String(reason).slice(0, 200);
  const next = currentBeat(quest);
  if (next && note) quest.beats[next.index].note = String(note).trim().slice(0, 400);
  quest.at = next ? next.index : quest.beats.length;
  return { beat: b, next, line: `Main quest: ${b.id} · ${b.title} ${b.status}${next ? `; next: ${next.id} · ${next.title}` : "; the quest is played through"}.` };
}

// What the GM tab shows.
export function questView(quest) {
  if (!quest) return null;
  const cur = currentBeat(quest);
  return { title: quest.title, premise: quest.premise, villain: quest.villain || null, by: quest.by, at: cur ? cur.index : quest.beats.length, unsaved: !!quest.dirty,
    beats: quest.beats.map((b) => ({ id: b.id, title: b.title, kind: b.kind, text: b.text, note: b.note, status: b.status, reason: b.reason })) };
}

export function questFileText(quest) {
  const { dirty, ...q } = quest;
  return JSON.stringify(q, null, 2) + "\n";
}

export function parseQuestFile(text) {
  try {
    const q = JSON.parse(text || "");
    if (!q || !Array.isArray(q.beats) || !q.beats.length) return null;
    return { ...q, dirty: 0 };
  } catch { return null; }
}

// The enemy behind the story: who they are, and how much of them the party may see by now.
function villainBlock(quest, at) {
  const v = quest.villain;
  if (!v?.name) return `THE ENEMY: this story has no villain yet. Invent one now (an original person, not one of the canon's fixed figures: someone with real power in one place, a magnate, a parish head, a fixer, a house's heir, an Unchained mind) and record them with the quest tool's villain field, then keep them consistent forever. Everything in the quest is their doing or in their way; the last beat is the party facing them.`;
  const reveal = Number.isInteger(v.revealAt) ? v.revealAt : Math.floor(quest.beats.length * 2 / 3);
  const last = quest.beats.length - 1;
  const stage = at >= last
    ? "NOW is the climax: the party faces them. They are in the scene, in person, with everything they have built. This is the fight, the bargain or the reckoning the whole story was for."
    : at >= reveal
      ? "The party knows who they are now. They may meet, threaten or bargain with them, but they never fall before the climax: they escape, hold the higher ground, or have the law on their side."
      : `Hidden until beat ${reveal + 1} (${quest.beats[reveal]?.id || "a Turn"}). Until then the party meets only their agents, their money, their orders and what they leave behind: a name in rumour, a seal on a contract, a face glimpsed and not recognised. Never say outright who is behind it yet.`;
  return `THE ENEMY (the story's villain; keep them consistent forever): ${v.name}, ${v.role}${v.faction ? ` (${v.faction})` : ""}.${v.face ? ` Looks: ${v.face}` : ""} Wants: ${v.want} Works through: ${v.method} Secret: ${v.secret}${v.weakness ? ` Weakness: ${v.weakness}` : ""}
${stage} Every beat is their doing, their cover-up or something in their way. When they first appear in the story, call remember_npc for them.`;
}

// The GM's private view of the quest, for its system prompt.
export function questBlock(quest) {
  if (!quest?.beats?.length) return "";
  const cur = currentBeat(quest);
  const done = quest.beats.filter((b) => b.status === "done").map((b) => b.id);
  const skipped = quest.beats.filter((b) => b.status === "skipped").map((b) => b.id);
  if (!cur) return `## MAIN QUEST (yours only; the players never see it)\n"${quest.title}" is played through. Let the story breathe: tie off loose ends, let consequences land. A new quest can be built from the Game Master tab when the table wants one.`;
  const next = quest.beats.slice(cur.index + 1).find((b) => b.status === "todo");
  return `## MAIN QUEST (yours only; the players never see it)
"${quest.title}": ${quest.premise}
${villainBlock(quest, cur.index)}
NOW, beat ${cur.index + 1} of ${quest.beats.length}: ${cur.id} · ${cur.title}. ${cur.text}${cur.note ? `\nYour take on it: ${cur.note}` : ""}
${next ? `After that: ${next.id} · ${next.title}${next.note ? ` (${next.note})` : ""}. Don't play it yet.` : "That is the last beat: the climax."}
${done.length ? `Done: ${done.join(", ")}. ` : ""}${skipped.length ? `Skipped: ${skipped.join(", ")}.` : ""}
- The quest is the story's spine, not a railroad. Steer toward the NOW beat through people, rumours, jobs, debts and consequences; let the players reach it their own way and in their own time. Side roads are fine; bring the beat back to them when they return.
- Never reveal later beats, name plot point IDs, or say "the quest" to the players.
- When the party has played through the NOW beat (resolved it, refused it, or made it moot), call the quest tool with done, and you may reshape the next beat's note to fit what happened. If their choices make the NOW beat impossible, call quest with skip and a reason.`;
}

export const PLANNER_PROMPT = `You plan the main quest for a campaign of EIDHOLM, a techfantasy text RPG. You are given the plot points, the party (names and backstories) and what has happened so far. Build the story's spine with the build_quest tool:
- Pick ${QUEST_MIN} to ${QUEST_MAX} plot points by ID and put them in order. The first must be a Hook (H…), the last a Climax (C…). Anything may sit between, including a second Hook or a Turn (R…); put Turns where a reveal hurts most.
- For every beat write a note of one or two sentences: where in Eidholm it happens (real places from the canon), who is involved (factions and people of the party's own size; never the continent's rulers, high clergy or named great figures), and what is at stake. Tie beats to each other and to the characters' backstories so it reads as one story, not a list of jobs.
- A title (a few words) and a premise (two or three sentences: what this story is about, what is really going on underneath).
- Exactly one Climax (C…), and it is the last beat. Never a Climax anywhere else. A second Hook early on is fine.
- THE VILLAIN. Every story has one enemy behind it, and you invent them for this story (villain): an original person, never one of the canon's fixed figures or rulers. Someone with real power in one place, big enough to be worth a whole story and small enough for this party to face at the end: a magnate, a parish head, a fixer, a house's heir, a guild officer, an Unchained mind. Give them a name, a role, a faction, a face, what they want, how they work (agents, money, law, faith), a secret, and a weakness the party can find. Pick the beat where the party learns who they are (revealed_at: a Turn is best). Every beat should be their doing, their cover-up or something in their way, and the Climax is the party facing them.
- The first beat is how the story opens: quiet, an errand, an offer, a meeting, a question. Never an ambush or a fight.
- Respect the canon: the Rim stays unexplained, the bank is neutral and is never beaten or bent, minds of glass are people and never property (they have licensees, employers and contracts; never an "owner").
- Don't invent debts for the party: a player character owes only what their sheet says. Debts can be part of the story (an NPC's, a household's, a loan the party may choose to take), never a debt the characters already have without knowing it.`;

export const PLANNER_TOOL = {
  type: "function",
  function: {
    name: "build_quest",
    description: "The main quest, in order.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        premise: { type: "string" },
        villain: { type: "object", properties: {
          name: { type: "string" }, role: { type: "string", description: "What they are, e.g. 'foundry magnate of the Seventh Ward'" },
          faction: { type: "string" }, face: { type: "string", description: "How they look and carry themselves" },
          want: { type: "string" }, method: { type: "string", description: "How they get it: agents, money, law, faith" },
          secret: { type: "string" }, weakness: { type: "string", description: "What the party can find and use against them" },
          revealed_at: { type: "string", description: "The beat ID where the party learns who they are (a Turn is best)" },
        }, required: ["name", "role", "want", "method", "secret", "revealed_at"] },
        beats: { type: "array", items: { type: "object", properties: {
          id: { type: "string", description: "A plot point ID, e.g. H2, T7, R1, C3" },
          note: { type: "string", description: "Where, who, what's at stake, in one or two sentences" },
        }, required: ["id", "note"] } },
      },
      required: ["title", "premise", "villain", "beats"],
    },
  },
};

export const QUEST_TOOL = {
  type: "function",
  function: {
    name: "quest",
    description: "Move the main quest on. done when the party has played through the NOW beat; skip (with a reason) when their choices made it impossible. At most once per answer. Also records the story's villain when it has none yet.",
    parameters: {
      type: "object",
      properties: {
        beat: { type: "string", enum: ["done", "skip", "none"], description: "none: only record the villain" },
        villain: { type: "object", description: "Only when the quest has no villain yet", properties: {
          name: { type: "string" }, role: { type: "string" }, faction: { type: "string" }, face: { type: "string" },
          want: { type: "string" }, method: { type: "string" }, secret: { type: "string" }, weakness: { type: "string" },
        } },
        reason: { type: "string", description: "Short: what happened" },
        next_note: { type: "string", description: "Optional: the next beat's note, reshaped to fit what happened" },
      },
      required: ["beat"],
    },
  },
};
