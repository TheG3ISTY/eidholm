// Eidholm spells: the named protocols, read straight from rules/spells.md so
// the rules file stays the one source of truth.
//
// Each tier's table rows look like:
//   | **Spark Query** | what it does | Ranged canting vs AC |

export const START_SPELLS = 2;   // tier-1 spells picked at creation

export function parseSpellbook(md) {
  const out = [];
  let tier = 0;
  for (const line of String(md || "").replace(/\r/g, "").split("\n")) {
    const h = line.match(/^##\s+Tier\s+(\d)\b/i);
    if (h) { tier = Number(h[1]); continue; }
    if (/^##\s/.test(line)) { tier = 0; continue; }
    if (!tier || tier > 5) continue;
    const row = line.match(/^\|\s*\*\*(.+?)\*\*\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*$/);
    if (!row) continue;
    out.push({
      name: row[1].trim(),
      tier,
      text: row[2].trim(),
      roll: row[3].trim(),
      skill: /ranged canting/i.test(row[3]) ? "ranged_canting" : "canting",
      lasting: isLasting(row[2]),
    });
  }
  return out;
}

// How long a held spell lasts, read from its text: minutes, "scene", or null (until let go).
const WORD_NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, ten: 10 };
export function spellDuration(text) {
  const t = String(text || "").toLowerCase();
  if (/\bfor the scene\b/.test(t)) return "scene";
  const m = t.match(/\bfor (an|a|one|two|three|ten|\d+) (minute|hour|day)s?\b/);
  if (!m) return null;
  const n = WORD_NUM[m[1]] ?? Number(m[1]);
  return n * { minute: 1, hour: 60, day: 1440 }[m[2]];
}

// A held spell lasts only while the canter holds it: one at a time (concentration).
// Marked in the spellbook's text with **Held.**
export function isLasting(text) {
  return /\*\*Held\.\*\*/.test(String(text || ""));
}

// Names are matched forgivingly: case, spacing, doubled letters and a typo or two
// ("Querry Flame" is Query Flame). Exact matches always win.
export function spellKey(name) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "").replace(/(.)\1+/g, "$1");
}
function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}
export function findSpell(list, name) {
  const k = String(name || "").trim().toLowerCase();
  if (!k) return undefined;
  const all = list || [];
  const exact = all.find((s) => String(s.name || "").trim().toLowerCase() === k);
  if (exact) return exact;
  const key = spellKey(k);
  const loose = all.find((s) => spellKey(s.name) === key);
  if (loose || key.length < 6) return loose;
  const near = all.map((s) => [s, editDistance(spellKey(s.name), key)]).filter(([, d]) => d <= 2).sort((a, b) => a[1] - b[1]);
  return near.length === 1 || (near.length > 1 && near[0][1] < near[1][1]) ? near[0][0] : undefined;
}

// Spells a player's action says they cast: a casting word and a spell's name (typos allowed).
const CAST_WORDS = /\b(cast|casts|casting|cant|cants|canting|channel|channels|invoke|invokes|weave|weaves|unleash|unleashes|counter|counters|throw|throws|hurl|hurls|fire|fires|use|uses|try|tries|attempt|attempts)\b/i;
export function spellsInAction(text, list) {
  const t = String(text || "");
  if (!CAST_WORDS.test(t)) return [];
  const words = t.split(/[^A-Za-z0-9']+/).filter(Boolean);
  const out = [];
  for (const s of list || []) {
    const n = String(s.name || "").split(/\s+/).length;
    for (let i = 0; i + n <= words.length; i++) {
      const cand = words.slice(i, i + n).join(" ");
      if (findSpell([s], cand) !== s) continue;
      // A one-word name that is also an ordinary word ("mend", "hush") counts only as a name:
      // capitalised, or right after a casting word ("cast mend").
      if (n === 1 && !/^[A-Z]/.test(words[i]) && !(i > 0 && CAST_WORDS.test(words[i - 1]))) continue;
      if (!out.includes(s)) out.push(s);
      break;
    }
  }
  return out;
}

// Which natural rolls miscant. Luck 13 takes away only the 1.
//   a spell on the sheet (taught, found, or cast successfully once): 1
//   a freeform cant's first cast: 1 up to its tier
// (A spellbook spell not on the sheet is learned by casting: the d8 alone is the cast, no d20.)
export function miscantOn({ freeform = false, tier = 1 } = {}) {
  return freeform ? Math.max(1, tier) : 1;
}

// Learning by casting: a straight d8 before the cast; equal to or lower than the tier fails.
export function learningFails(d8, tier) {
  return d8 <= tier;
}
