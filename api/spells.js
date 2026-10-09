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

// A held spell lasts only while the canter holds it: one at a time (concentration).
// Marked in the spellbook's text with **Held.**
export function isLasting(text) {
  return /\*\*Held\.\*\*/.test(String(text || ""));
}

export function findSpell(list, name) {
  const k = String(name || "").trim().toLowerCase();
  return k ? (list || []).find((s) => String(s.name || "").trim().toLowerCase() === k) : undefined;
}

// Which natural rolls miscant. Luck 13 takes away only the 1.
//   a spell on the sheet (taught, found, or cast successfully once): 1
//   a freeform cant's first cast: 1 up to its tier
// (A spellbook spell not on the sheet is learned by casting: the d8 gate decides, then 1.)
export function miscantOn({ freeform = false, tier = 1 } = {}) {
  return freeform ? Math.max(1, tier) : 1;
}

// Learning by casting: a straight d8 before the cast; equal to or lower than the tier fails.
export function learningFails(d8, tier) {
  return d8 <= tier;
}
