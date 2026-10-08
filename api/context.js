// Eidholm context: what the GM reads each turn.
//
// The canon, the economy and the rules are split into labelled chunks. Each
// turn the server loads only the chunks the scene needs, plus a one-line
// index of everything else, so the GM always knows what exists without
// re-reading the whole library. The scene comes from a hidden tag the GM
// writes at the end of every answer, backed up by a keyword scan of what the
// players just typed.

// ---------------------------------------------------------------------------
// Topics: what each chunk is about, and which words in play summon it.
// ---------------------------------------------------------------------------

export const TOPICS = {
  concord:    ["concord", "kalvane", "caldera", "baron", "combine", "patent", "emberreach", "foundry", "rim-council", "clansmine", "deephold", "forge"],
  league:     ["league", "verdant", "corso", "bell", "duel", "duelling", "dueling", "speaker", "lyceum", "academy", "academies", "parliament"],
  flotillas:  ["flotilla", "wrackmother", "sorrow", "salvage", "council tide", "leviathan", "drowned", "subsidence", "diver", "shipwreck", "hull"],
  custodians: ["custodian", "bastion", "castellan", "census", "shard", "licence", "license"],
  unchained:  ["unchained", "ambassador", "warlord", "philosopher"],
  bank:       ["bank", "covenant", "bonds", "debt", "loan", "enforcer", "final notice", "interest", "auction", "creditor"],
  choir:      ["choir", "precentor", "echo", "anchoring", "anchored", "anchorer", "registrar", "registry", "funeral", "decompos", "ghost", "enfranchis", "nullis", "inquisitor"],
  rust:       ["rust gospel", "maintainer", "devote", "devotion", "chassis", "reliquary"],
  deepgreen:  ["deepgreen", "grove", "dream", "forest", "dreamfast", "relinquish", "warden"],
  silence:    ["silence", "copy-house", "copyist", "triplicate", "notary"],
  weave:      ["weave", "lattice", "cant ", "canting", "canter", "artifice", "artificer", "chamber", "miscant", "spell", "array", "focus", "cast a", "magic"],
  minds:      ["mind of glass", "minds of glass", "hearthmind", "cathedral mind", "calder", " ai "],
  faith:      ["faith", "church", "temple", "priest", "god", "pray", "prayer", "soul", "holy", "heresy", "heretic"],
  death:      ["dead", "death", "corpse", "grave", "burial", "funeral", "echo", "ghost", "wiring-ghost"],
  war:        ["fight", "attack", "combat", "sword", "blade", "armor", "armour", "shield", "battle", "weapon", "soldier", "skiff", "gun", "duel"],
  trade:      ["buy", "sell", "price", "cost", "shop", "merchant", "trade", "market", "pay", "coin", "covenant", "room", "inn", "meal", "repair", "barter", "haggle", "afford", "gear", "equipment", "item"],
  money:      ["job", "wage", "income", "work for", "hire", "loan", "debt", "interest", "savings", "patent"],
  illegal:    ["black market", "gray market", "grey market", "contraband", "smuggl", "illegal", "fence", "stolen"],
  travel:     ["travel", "journey", "road", "ship", "ride", "rail", "train", "cross", "border", "distance"],
};

// Scene modes the GM can declare, and the topics each one pulls in.
export const MODES = {
  combat:    ["war"],
  trade:     ["trade", "money"],
  travel:    ["travel"],
  social:    [],
  explore:   [],
  downtime:  ["money", "trade"],
  creation:  ["*"],   // character creation: the GM needs the whole world
};

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

const unescape = (t) => String(t || "").replace(/\\([\\`*_{}\[\]()#+\-.!>])/g, "$1");

// Which topics a canon chunk belongs to, decided by its title.
function canonTopics(title) {
  const t = title.toLowerCase();
  const rules = [
    [/premise/, ["core"]],
    [/the weave/, ["weave"]],
    [/minds of glass/, ["minds"]],
    [/emberreach/, ["concord"]],
    [/verdant league \(center\)|^the verdant league \(/, ["league"]],
    [/sorrow coast/, ["flotillas"]],
    [/the rim \(the polar cap\)|the rim — unnamed/, ["core"]],
    [/geography/, ["travel"]],
    [/combine concord/, ["concord"]],
    [/verdant league/, ["league"]],
    [/sorrow flotillas/, ["flotillas"]],
    [/custodians/, ["custodians", "minds"]],
    [/unchained court/, ["unchained", "minds"]],
    [/the bank/, ["bank", "trade"]],
    [/choir eternal/, ["choir", "faith", "death"]],
    [/rust gospel/, ["rust", "concord", "faith"]],
    [/deepgreen/, ["deepgreen", "league", "faith"]],
    [/the silence/, ["silence", "faith"]],
    [/death across/, ["death", "faith", "choir"]],
    [/^vi\. faith/, ["faith"]],
    [/powers that be/, ["core"]],
    [/weapons & warfare/, ["war"]],
  ];
  for (const [re, topics] of rules) if (re.test(t)) return topics;
  return [];
}

// world/worldbuilding.md -> chunks. Sections are the numbered headings;
// Powers (V) and Faith (VI) are split further into their named entries,
// Geography (IV) into its regions.
export function chunkCanon(text) {
  const lines = unescape(text).replace(/\r/g, "").split("\n");
  const sections = [];
  let cur = { title: "Preface", lines: [] };
  for (const line of lines) {
    if (/^(I|II|III|IV|V|VI|VII|VIII|IX|X)\.\s+\S/.test(line.trim())) {
      sections.push(cur);
      cur = { title: line.trim(), lines: [] };
    } else cur.lines.push(line);
  }
  sections.push(cur);

  const chunks = [];
  const add = (title, body) => {
    const t = body.trim();
    if (!t) return;
    chunks.push({ id: "canon:" + title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""), source: "canon", title, text: t, topics: canonTopics(title) });
  };

  for (const s of sections) {
    const roman = s.title.split(".")[0];
    if (s.title === "Preface") {
      // The title lines belong with the premise.
      sections.find((x) => x.title.startsWith("I."))?.lines.unshift(...s.lines);
      continue;
    }
    if (roman === "V" || roman === "VI") {
      // Named entries: a short title line ending in two spaces, then its text.
      let entry = { title: s.title, lines: [] };
      for (const line of s.lines) {
        const isTitle = /  $/.test(line) && line.trim().length < 80 && !/^[-\\]/.test(line.trim()) &&
          /^(The |Deepgreen|Death Across)/.test(line.trim());
        if (isTitle) {
          add(entry.title, entry.lines.join("\n"));
          entry = { title: line.trim(), lines: [] };
        } else entry.lines.push(line);
      }
      add(entry.title, entry.lines.join("\n"));
    } else if (roman === "IV") {
      const paras = s.lines.join("\n").split(/\n\s*\n/);
      add(s.title, paras.filter((p) => !/^The (Emberreach|Verdant League|Sorrow Coast|Rim) \(/.test(p.trim())).join("\n\n"));
      for (const p of paras.filter((p) => /^The (Emberreach|Verdant League|Sorrow Coast|Rim) \(/.test(p.trim()))) {
        add(p.trim().split(".")[0], p);
      }
    } else {
      add(s.title, s.lines.join("\n"));
    }
  }
  return chunks;
}

// Markdown split at "## " (and "### " inside the Adopted rules).
export function chunkMarkdown(text, source, topicsByTitle, { level = 2 } = {}) {
  const re = level === 3 ? /^#{2,3} / : /^## /;
  const chunks = [];
  let cur = null;
  for (const line of String(text || "").replace(/\r/g, "").split("\n")) {
    if (re.test(line)) {
      if (cur) chunks.push(cur);
      const title = line.replace(/^#+\s*/, "").trim();
      cur = { id: `${source}:${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`, source, title, lines: [], topics: topicsByTitle(title) };
    } else if (cur) cur.lines.push(line);
  }
  if (cur) chunks.push(cur);
  return chunks
    .map((c) => ({ id: c.id, source: c.source, title: c.title, text: c.lines.join("\n").trim(), topics: c.topics }))
    .filter((c) => c.text && !c.topics.includes("skip"));
}

export function economyTopics(title) {
  const t = title.toLowerCase();
  if (t.startsWith("two layers")) return ["trade"];
  if (t.startsWith("the currency")) return ["trade", "bank"];
  if (t.startsWith("scale")) return ["trade", "travel"];
  if (t.startsWith("gear tiers")) return ["trade"];
  if (t.startsWith("minds of glass")) return ["minds", "money"];
  if (t.startsWith("exchange")) return ["trade"];
  if (t.startsWith("how money moves")) return ["money", "bank"];
  if (t.startsWith("illegal")) return ["illegal", "trade"];
  if (t.startsWith("items on the sheet")) return ["trade", "war"];
  if (t.startsWith("pending")) return ["skip"];
  return ["trade"];
}

export function rulesTopics(title) {
  const t = title.toLowerCase();
  if (t.startsWith("dice")) return ["core"];
  if (t.startsWith("open questions")) return ["core"];
  if (t.startsWith("adopted") || t.startsWith("economy and equipment")) return ["skip"];
  if (t.startsWith("remembering") || t.startsWith("fixed figures")) return ["index"];   // already in the GM's instructions and the cast
  return ["core"];
}

// rules/characters.md, split at "## " and "### ". The server already does the
// arithmetic (modifiers, HP, pools, marks), so the GM mostly needs the shape.
export function characterTopics(title) {
  const t = title.toLowerCase();
  if (/^eidholm|^stats|^modifiers|^origin|^the clock/.test(t)) return ["core"];
  if (/^luck|^lattice-shields|^dying/.test(t)) return ["war"];
  if (/^resonance|^miscants/.test(t)) return ["weave"];
  if (/^scars/.test(t)) return ["death", "war"];
  if (/^starting kit|^allocation|^at creation/.test(t)) return ["creation"];
  return ["index"];
}

// ---------------------------------------------------------------------------
// The scene tag
// ---------------------------------------------------------------------------
//
// The GM ends every answer with one line, which players never see:
//   [[scene: mode=combat; where=Slag Ward, Kalvane; present=Teodor; factions=Concord; topics=patents]]

const TAG_ANY = /\[\[\s*scene\s*:([^\]]*)\]\]/gi;

// Reads the last tag wherever it is, and strips every tag so players never see one.
export function parseSceneTag(reply) {
  const all = [...String(reply || "").matchAll(TAG_ANY)];
  const clean = String(reply || "").replace(TAG_ANY, "").replace(/\n{3,}/g, "\n\n").trim();
  if (!all.length) return { text: clean, scene: null };
  const m = all[all.length - 1];
  const scene = { mode: "", where: "", present: [], factions: [], topics: [] };
  for (const part of m[1].split(";")) {
    const [k, ...rest] = part.split("=");
    const key = (k || "").trim().toLowerCase();
    const val = rest.join("=").trim();
    if (!key) continue;
    if (key === "mode") scene.mode = val.toLowerCase().split(/[,\s]+/)[0] || "";
    else if (key === "where") scene.where = val.slice(0, 120);
    else if (key === "time") scene.time = val.slice(0, 20);
    else if (key in scene) scene[key] = val.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 12);
  }
  if (!(scene.mode in MODES)) scene.mode = scene.mode ? "social" : "";
  return { text: clean, scene };
}

export function formatSceneTag(scene) {
  if (!scene) return "";
  return `[[scene: mode=${scene.mode || "social"}; where=${scene.where || ""}; present=${(scene.present || []).join(", ")}; factions=${(scene.factions || []).join(", ")}; topics=${(scene.topics || []).join(", ")}${scene.time ? `; time=${scene.time}` : ""}]]`;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

function topicsInText(text) {
  const t = " " + String(text || "").toLowerCase() + " ";
  const hit = new Set();
  for (const [topic, words] of Object.entries(TOPICS)) if (words.some((w) => t.includes(w))) hit.add(topic);
  return hit;
}

// Ways a remembered person might be referred to: full name, distinctive name
// parts, and their title ("the Speaker", "the Precentor").
function handles(person) {
  const stop = new Set(["the", "of", "and", "deephold", "varek", "hollowwood"]);
  const out = new Set([String(person.name).toLowerCase()]);
  for (const part of String(person.name).toLowerCase().split(/[\s,]+/)) if (part.length >= 4 && !stop.has(part)) out.add(part);
  const title = String(person.role || "").split(/[;(,]/)[0].toLowerCase().trim();
  const firstWord = title.split(" ")[0];
  if (firstWord && firstWord.length >= 5 && !["mind", "kalvane's", "master", "keeper", "head", "the"].includes(firstWord)) out.add(firstWord);
  if (/final notice/.test(String(person.name).toLowerCase())) out.add("final notice");
  return [...out];
}

// Choose what the GM reads this turn.
//   library: { canon, economy, rules } chunk arrays; cast: array of people
//   scene:   the last scene tag (or null); recent: text of this round + the last GM reply
export function selectContext({ library, cast, scene, recent }) {
  const mode = scene?.mode || "";
  const wanted = topicsInText([recent, scene?.where, ...(scene?.factions || []), ...(scene?.topics || [])].join(" \n "));
  for (const t of MODES[mode] || []) wanted.add(t);
  const everything = (MODES[mode] || []).includes("*");

  const pick = (chunks) => chunks.filter((c) => c.topics.includes("core") || everything || c.topics.some((t) => wanted.has(t)));

  const canon = library.canon.filter((c) => !c.topics.includes("index"));
  const loadedCanon = pick(canon);
  const loadedEconomy = everything ? library.economy.filter((c) => !c.topics.includes("minds") || wanted.has("minds")) : pick(library.economy);
  const loadedRules = library.rules.filter((c) => c.topics.includes("core") ||
    (!c.topics.includes("index") && (everything || c.topics.some((t) => wanted.has(t)))));

  // People: in full when present, named, or referred to by title; otherwise one line.
  const hay = " " + [recent, ...(scene?.present || []), scene?.where].join(" \n ").toLowerCase() + " ";
  const full = [], brief = [];
  for (const p of cast) {
    if (p.status === "dead" || p.status === "dormant") { brief.push(p); continue; }
    const named = handles(p).some((h) => hay.includes(h));
    (named ? full : brief).push(p);
  }

  const notLoaded = (all, loaded) => all.filter((c) => !loaded.includes(c));
  const index = {
    canon: notLoaded(canon, loadedCanon).map((c) => c.title),
    economy: notLoaded(library.economy, loadedEconomy).map((c) => c.title),
    rules: library.rules.filter((c) => !loadedRules.includes(c)).map((c) => c.title),
    people: brief,
  };
  return { mode, wanted: [...wanted], loadedCanon, loadedEconomy, loadedRules, full, index };
}

// One line per person: enough to know they exist and where.
export function personLine(p) {
  const role = String(p.role || "").split(/[;(]/)[0].trim();
  return `${p.name}${role ? `, ${role}` : ""}${p.where ? ` (${String(p.where).split(/[;,]/)[0].trim()})` : ""}` +
    (p.status === "dead" ? " [dead]" : p.status === "dormant" ? " [dormant]" : "");
}

// What the GM reads about a person it needs in full.
export function personFull(p) {
  const skip = new Set(["name", "status", "first_seen_session", "last_seen_session", "pillar"]);
  return `- ${p.pillar ? "[fixed figure] " : ""}${p.name}: ` +
    Object.entries(p).filter(([k]) => !skip.has(k)).map(([k, v]) => `${k.replace(/_/g, " ")}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join("; ");
}

// Free-text search for the GM's lookup tool.
export function lookup(query, library, cast) {
  const words = String(query || "").toLowerCase().split(/[^a-z0-9']+/).filter((w) => w.length >= 3);
  if (!words.length) return [];
  const score = (title, text) => words.reduce((n, w) => n + (title.toLowerCase().includes(w) ? 5 : 0) + (text.toLowerCase().includes(w) ? 1 : 0), 0);
  const docs = [
    ...library.canon, ...library.economy, ...library.rules,
    ...cast.map((p) => ({ id: "person:" + p.name, title: p.name, text: JSON.stringify(p) })),
  ];
  return docs.map((d) => ({ d, s: score(d.title, d.text) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 2).map((x) => x.d);
}
