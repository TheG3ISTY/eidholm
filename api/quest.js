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

// What the planner (or a person) sent, checked against the plot points. Returns { quest } or { problems }.
export function questFromArgs(args, points) {
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
  if (beats.some((b) => !b.note)) problems.push(`Every beat needs its own note: where, who, what's at stake.`);
  const title = String(args?.title || "").trim().slice(0, 80);
  const premise = String(args?.premise || "").trim().slice(0, 600);
  if (!title) problems.push("The quest needs a title.");
  if (!premise) problems.push("The quest needs a premise.");
  if (problems.length) return { problems };
  return { quest: { title, premise, beats, at: 0, builtAt: Date.now(), by: "gm" } };
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
  return { title: "The story so far", premise: "Built at random from the plot points; give each beat its shape as you reach it.", beats, at: 0, builtAt: Date.now(), by: "random" };
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
  return { title: quest.title, premise: quest.premise, by: quest.by, at: cur ? cur.index : quest.beats.length, unsaved: !!quest.dirty,
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
- The first beat is how the story opens: quiet, an errand, an offer, a meeting, a question. Never an ambush or a fight.
- Respect the canon: the Rim stays unexplained, the bank is neutral and is never beaten or bent, minds of glass are people and never property.`;

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
        beats: { type: "array", items: { type: "object", properties: {
          id: { type: "string", description: "A plot point ID, e.g. H2, T7, R1, C3" },
          note: { type: "string", description: "Where, who, what's at stake, in one or two sentences" },
        }, required: ["id", "note"] } },
      },
      required: ["title", "premise", "beats"],
    },
  },
};

export const QUEST_TOOL = {
  type: "function",
  function: {
    name: "quest",
    description: "Move the main quest on. done when the party has played through the NOW beat; skip (with a reason) when their choices made it impossible. At most once per answer.",
    parameters: {
      type: "object",
      properties: {
        beat: { type: "string", enum: ["done", "skip"] },
        reason: { type: "string", description: "Short: what happened" },
        next_note: { type: "string", description: "Optional: the next beat's note, reshaped to fit what happened" },
      },
      required: ["beat"],
    },
  },
};
