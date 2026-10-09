// Eidholm spells: the named protocols, read straight from rules/spells.md so
// the rules file stays the one source of truth.
//
// Each tier's table rows look like:
//   | **Spark Query** | what it does | Ranged canting vs AC |

export const START_SPELLS = 2;   // tier-1 spells picked at creation, unproven

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
    });
  }
  return out;
}

export function findSpell(list, name) {
  const k = String(name || "").trim().toLowerCase();
  return k ? (list || []).find((s) => String(s.name || "").trim().toLowerCase() === k) : undefined;
}

// Which natural rolls miscant. Luck 13 takes away only the 1.
//   proven spell 1 · unproven or freeform 1-2 · a first tier-6 fusion 1-3
export function miscantOn({ proven = true, freeform = false, fusion = false } = {}) {
  if (fusion) return 3;
  if (freeform || !proven) return 2;
  return 1;
}
