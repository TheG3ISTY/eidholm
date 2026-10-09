// Eidholm characters: the sheet, its derived numbers, and everything that
// changes it during play. Pure functions; the Table keeps the live sheets.
// The rules these implement are in rules/characters.md.

import { rollDice } from "./dice.js";

export const STATS = ["strength", "perception", "endurance", "charisma", "intelligence", "agility", "luck", "resonance"];
export const STAT_LABEL = {
  strength: "Strength", perception: "Perception", endurance: "Endurance", charisma: "Charisma",
  intelligence: "Intelligence", agility: "Agility", luck: "Luck", resonance: "Resonance",
};

export const SKILLS = {
  small_melee: "Small melee", medium_melee: "Medium melee", large_melee: "Large melee", ranged: "Ranged",
  heavy_armor: "Heavy armor", light_armor: "Light armor", unarmored: "Unarmored combat",
  canting: "Canting", ranged_canting: "Ranged canting", artifice: "Artifice",
  survival: "Survival", medicine: "Medicine", creation: "Creation", thievery: "Thievery", performance: "Performance",
};
export const MELEE_SKILLS = ["small_melee", "medium_melee", "large_melee", "unarmored"];
export const CANTING_SKILLS = ["canting", "ranged_canting"];

export const RANKS = ["Untrained", "Familiar", "Novice", "Trained", "Adept", "Expert", "Master", "Legend"];
export const MARKS_TO_REACH = [0, 1, 2, 4, 8, 16, 32, 64];   // marks needed to reach rank i from rank i-1
export const MAX_RANK = 7;
export const LEVEL_CAP = 50;

export const SPELL_COST = [0, 2, 4, 8, 14, 22, 39];
export const BACKLASH = [null, "1d4", "2d6", "4d6", "6d8", "8d10", "10d12"];
export const RECOVERY_PER_HOUR = 0.125;
export const DAWN_MINUTE = 6 * 60;
export const START_PURSE = 50;
export const START_ITEMS = 3;

export const CAPSTONES = {
  strength: ["Titan's grip", "Wield two-handed weapons in one hand; the free hand may hold a shield."],
  perception: ["No blind side", "Never surprised or flanked; shields and blocks work in every direction."],
  endurance: ["Won't stay down", "Once per in-game day, dropping to 0 HP returns you to d100 HP instead. Immune to exhaustion."],
  charisma: ["Your word is law", "Once per scene, a non-pillar NPC must carry out one order unless it would kill them."],
  intelligence: ["Masterwork", "Creation comes out one quality step higher; only you can make Masterwork. Any lattice device works for you on first touch."],
  agility: ["Pinpoint", "Once per combat, choose the face of every die in one of your attacks. A chosen 20 is a natural 20."],
  luck: ["Never fumble", "No critical failures: a natural 1 is just a 1, never an automatic miss, never a miscant."],
  resonance: ["Tier 6", "The only way to cast tier 6 spells."],
};

// The starting kit. Armor adds to AC; `armor` says which skill wearing it trains.
export const STARTER_ITEMS = [
  { id: "dagger", name: "Dagger", kind: "weapon", skill: "small_melee", damage: "1d4" },
  { id: "baton", name: "Baton", kind: "weapon", skill: "small_melee", damage: "1d4" },
  { id: "sword", name: "Sword", kind: "weapon", skill: "medium_melee", damage: "1d8" },
  { id: "mace", name: "Mace", kind: "weapon", skill: "medium_melee", damage: "1d6" },
  { id: "greatsword", name: "Greatsword", kind: "weapon", skill: "large_melee", damage: "2d6", twoHanded: true },
  { id: "halberd", name: "Halberd", kind: "weapon", skill: "large_melee", damage: "1d10", twoHanded: true },
  { id: "bow", name: "Bow", kind: "weapon", skill: "ranged", damage: "1d6", twoHanded: true },
  { id: "crossbow", name: "Crossbow", kind: "weapon", skill: "ranged", damage: "1d8", twoHanded: true },
  { id: "throwing_knives", name: "Throwing knives", kind: "weapon", skill: "ranged", damage: "1d4" },
  { id: "padded_coat", name: "Padded coat", kind: "armor", armor: "light_armor", ac: 1 },
  { id: "leather_jack", name: "Leather jack", kind: "armor", armor: "light_armor", ac: 2 },
  { id: "battered_mail", name: "Battered mail", kind: "armor", armor: "heavy_armor", ac: 4, condition: "Damaged" },
  { id: "lattice_shield", name: "Battered lattice-shield", kind: "shield", skill: "heavy_armor", shieldPool: 500, condition: "Damaged" },
  { id: "medic_satchel", name: "Medic's satchel", kind: "tool", skill: "medicine" },
  { id: "pick_roll", name: "Pick-and-wire roll", kind: "tool", skill: "thievery" },
  { id: "field_kit", name: "Field kit (rope, tarp, flint)", kind: "tool", skill: "survival" },
  { id: "tinker_case", name: "Tinker's case", kind: "tool", skill: "creation" },
  { id: "salvage_gauge", name: "Salvage gauge", kind: "tool", skill: "artifice" },
  { id: "focus_bead", name: "Focus bead", kind: "tool", skill: "canting" },
  { id: "energy_staff", name: "Cracked energy staff", kind: "weapon", skill: "ranged_canting", damage: "1d8", twoHanded: true, quality: "Crude" },
];

// ---------------------------------------------------------------- numbers

// A 10 plays as an 11; the capstone 13 plays as 13.
export function plays(v) {
  v = Number(v) || 0;
  return v === 10 ? 11 : v;
}
export function statValue(sheet, stat) {
  if (sheet.capstone === stat) return 13;
  return clamp(Math.trunc(Number(sheet.stats?.[stat]) || 5), 1, 10);
}
export function statMod(sheet, stat) {
  return plays(statValue(sheet, stat)) - 5;
}

// Cost of a stat relative to the starting 5: 1 per step, the 9 to 10 step costs 2.
export function statCost(v) {
  return v - 5 + (v >= 10 ? 1 : 0);
}
export function totalStatCost(stats) {
  return STATS.reduce((n, s) => n + statCost(clamp(Math.trunc(Number(stats?.[s]) || 5), 1, 10)), 0);
}

export function skillRank(sheet, skill) {
  return clamp(Math.trunc(Number(sheet.skills?.[skill]?.rank) || 0), 0, MAX_RANK);
}
export function skillBonus(sheet, skill) {
  return Math.max(0, skillRank(sheet, skill) - 1);
}
export function ranksEarned(sheet) {
  return Object.keys(SKILLS).reduce((n, k) => n + skillRank(sheet, k), 0);
}
export function level(sheet) {
  return Math.min(LEVEL_CAP, 1 + Math.floor(ranksEarned(sheet) / 2));
}
export function unspentPoints(sheet) {
  return level(sheet) - 1 - totalStatCost(sheet.stats);
}

export function equipped(sheet) {
  return (sheet.items || []).filter((i) => i && i.equipped);
}

export function derive(sheet) {
  const lvl = level(sheet);
  const E = plays(statValue(sheet, "endurance"));
  const R = plays(statValue(sheet, "resonance"));
  const armorAc = equipped(sheet).filter((i) => i.kind === "armor").reduce((n, i) => n + (Number(i.ac) || 0), 0);
  const gearPool = equipped(sheet).reduce((n, i) => n + (Number(i.pool) || 0), 0);
  const gearRecovery = equipped(sheet).reduce((n, i) => n + (Number(i.recovery) || 0), 0);
  const luckMod = statMod(sheet, "luck");
  return {
    level: lvl,
    maxHp: 8 + 2 * E + (lvl - 1) * Math.ceil(E / 2),
    ac: 10 + statMod(sheet, "agility") + armorAc,
    initiative: statMod(sheet, "agility"),
    carryKg: statValue(sheet, "strength") * 10,
    maxPool: R * 4 + gearPool,
    recovery: RECOVERY_PER_HOUR + gearRecovery,     // fraction of the max pool per hour
    maxTier: sheet.capstone === "resonance" ? 6 : Math.min(5, Math.floor(R / 2)),
    luckyBreaks: Math.max(0, luckMod),
    critOn: statValue(sheet, "luck") >= 9 ? 19 : 20,
    noFumble: sheet.capstone === "luck",
    unspent: unspentPoints(sheet),
    ranks: ranksEarned(sheet),
  };
}

// ---------------------------------------------------------------- creation

// Validates a creation request and returns a fresh sheet, or throws.
// tier1: the tier-1 spells a new character may pick from (from rules/spells.md).
export function createSheet(input, player, tier1 = [], startSpells = 2) {
  const name = text(input?.name, 40);
  if (!name) throw new Error("Your character needs a name.");
  const stats = {};
  for (const s of STATS) {
    const v = Math.trunc(Number(input?.stats?.[s]));
    if (!Number.isFinite(v) || v < 1 || v > 10) throw new Error(`${STAT_LABEL[s]} must be between 1 and 10.`);
    stats[s] = v;
  }
  const balance = totalStatCost(stats);
  if (balance !== 0) {
    throw new Error(balance > 0
      ? `You've spent ${balance} point${balance === 1 ? "" : "s"} more than you freed up. Lower something.`
      : `You still have ${-balance} point${balance === -1 ? "" : "s"} to place.`);
  }
  const picks = Array.isArray(input?.items) ? [...new Set(input.items)] : [];
  if (picks.length !== START_ITEMS) throw new Error(`Pick exactly ${START_ITEMS} items.`);
  const items = picks.map((id) => {
    const it = STARTER_ITEMS.find((x) => x.id === id);
    if (!it) throw new Error("One of those items isn't on the starting list.");
    const { id: _id, ...rest } = it;
    return { ...rest, tier: 1, quality: it.quality || "Standard", condition: it.condition || "Worn", legality: "Legal", equipped: it.kind === "armor" };
  });
  const spellPicks = Array.isArray(input?.spells) ? [...new Set(input.spells.map(String))] : [];
  if (tier1.length && spellPicks.length !== startSpells) throw new Error(`Pick exactly ${startSpells} tier-1 spells.`);
  const spells = spellPicks.map((n) => {
    const sp = tier1.find((x) => x.name.toLowerCase() === n.trim().toLowerCase());
    if (!sp) throw new Error(`"${n}" isn't a tier-1 spell.`);
    return { name: sp.name, tier: 1, proven: false };
  });
  // Only one suit of armor worn at a time.
  let worn = false;
  for (const i of items) if (i.kind === "armor") { i.equipped = !worn; worn = true; }

  const sheet = {
    name,
    player: text(player, 40),
    backstory: text(input?.backstory, 4000, true),
    stats,
    capstone: null,
    skills: {},
    items,
    spells,
    purse: START_PURSE,
    scars: [],
    created: new Date().toISOString().slice(0, 10),
  };
  const d = derive(sheet);
  sheet.hp = d.maxHp;
  sheet.pool = d.maxPool;
  sheet.luckUsed = 0;
  sheet.enduranceUsed = false;
  sheet.dying = null;
  sheet.dead = false;
  sheet.scarsOwed = 0;
  return sheet;
}

// Fill in anything a hand-edited or older sheet is missing, without touching what's there.
export function normalize(sheet) {
  if (!sheet || typeof sheet !== "object") return sheet;
  sheet.stats = sheet.stats && typeof sheet.stats === "object" ? sheet.stats : {};
  for (const s of STATS) if (sheet.stats[s] == null) sheet.stats[s] = 5;
  sheet.skills = sheet.skills && typeof sheet.skills === "object" ? sheet.skills : {};
  sheet.items = Array.isArray(sheet.items) ? sheet.items : [];
  sheet.scars = Array.isArray(sheet.scars) ? sheet.scars : [];
  sheet.spells = Array.isArray(sheet.spells) ? sheet.spells.filter((x) => x && x.name) : [];
  if (!STATS.includes(sheet.capstone)) sheet.capstone = null;
  const d = derive(sheet);
  if (!Number.isFinite(sheet.hp)) sheet.hp = d.maxHp;
  if (!Number.isFinite(sheet.pool)) sheet.pool = d.maxPool;
  if (!Number.isFinite(sheet.purse)) sheet.purse = 0;
  sheet.luckUsed = Number(sheet.luckUsed) || 0;
  sheet.enduranceUsed = !!sheet.enduranceUsed;
  sheet.scarsOwed = Number(sheet.scarsOwed) || 0;
  sheet.dead = !!sheet.dead;
  if (sheet.dying && typeof sheet.dying !== "object") sheet.dying = null;
  return sheet;
}

// ---------------------------------------------------------------- growth

// Spend a level-up point on a stat. Returns a line for the table.
export function raiseStat(sheet, stat) {
  if (!STATS.includes(stat)) throw new Error("Which stat?");
  if (sheet.capstone === stat) throw new Error(`${STAT_LABEL[stat]} is already your capstone.`);
  const v = statValue(sheet, stat);
  if (v >= 10) throw new Error(`${STAT_LABEL[stat]} is already at 10.`);
  const cost = statCost(v + 1) - statCost(v);
  if (unspentPoints(sheet) < cost) throw new Error(cost === 2 ? "The step to 10 costs 2 points." : "No stat points to spend.");
  const before = derive(sheet);
  sheet.stats[stat] = v + 1;
  settleCaps(sheet, before);
  return `${sheet.name} raises ${STAT_LABEL[stat]} to ${v + 1}.`;
}

export function takeCapstone(sheet, stat) {
  if (!STATS.includes(stat)) throw new Error("Which stat?");
  if (level(sheet) < LEVEL_CAP) throw new Error(`The capstone comes at level ${LEVEL_CAP}.`);
  if (sheet.capstone) throw new Error("You already have your capstone.");
  const before = derive(sheet);
  sheet.capstone = stat;
  settleCaps(sheet, before);
  return `${sheet.name} reaches the capstone: ${STAT_LABEL[stat]} 13, ${CAPSTONES[stat][0]}.`;
}

// Raising Endurance or Resonance raises the maximum, and the current value with it.
function settleCaps(sheet, before) {
  const d = derive(sheet);
  if (before && !sheet.dying && !sheet.dead) {
    sheet.hp += Math.max(0, d.maxHp - before.maxHp);
    sheet.pool += Math.max(0, d.maxPool - before.maxPool);
  }
  sheet.hp = Math.min(sheet.hp, d.maxHp);
  sheet.pool = Math.min(sheet.pool, d.maxPool);
}

// One mark for a skill. Returns table lines for anything that changed.
export function addMark(sheet, skill) {
  if (!SKILLS[skill]) return [];
  const cur = sheet.skills[skill] || { rank: 0, marks: 0 };
  const rank = clamp(Math.trunc(Number(cur.rank) || 0), 0, MAX_RANK);
  if (rank >= MAX_RANK) return [];
  const before = level(sheet);
  let marks = (Number(cur.marks) || 0) + 1;
  const out = [];
  let newRank = rank;
  if (marks >= MARKS_TO_REACH[rank + 1]) {
    newRank = rank + 1;
    marks = 0;
    out.push(`${sheet.name} is now ${RANKS[newRank]} in ${SKILLS[skill]}.`);
  }
  sheet.skills[skill] = { rank: newRank, marks };
  const after = level(sheet);
  if (after > before) {
    // Every new level adds HP the same way it would have at creation.
    const gained = derive(sheet).maxHp - derive({ ...sheet, skills: { ...sheet.skills, [skill]: { rank, marks: 0 } } }).maxHp;
    if (!sheet.dying && !sheet.dead) sheet.hp += Math.max(0, gained);
    out.push(after === LEVEL_CAP
      ? `${sheet.name} reaches level ${LEVEL_CAP}: the capstone is theirs to choose.`
      : `${sheet.name} reaches level ${after}: a stat point to spend.`);
  }
  return out;
}

// ---------------------------------------------------------------- harm

// Apply damage. opts: { crit, miscant, random }. Returns table lines.
export function takeDamage(sheet, amount, opts = {}) {
  amount = Math.max(0, Math.trunc(Number(amount) || 0));
  if (!amount || sheet.dead) return [];
  const out = [];
  const max = derive(sheet).maxHp;

  if (sheet.dying) {
    if (opts.miscant) return out;
    sheet.dying.f += opts.crit ? 2 : 1;
    sheet.dying.stable = false;
    out.push(`${sheet.name} is hit while down: ${sheet.dying.f} failed death save${sheet.dying.f === 1 ? "" : "s"}.`);
    if (sheet.dying.f >= 3) die(sheet, out);
    return out;
  }

  const overflow = amount - sheet.hp;
  sheet.hp = Math.max(0, sheet.hp - amount);
  if (sheet.hp > 0) return out;

  if (sheet.capstone === "endurance" && !sheet.enduranceUsed) {
    const r = rollDice("d100", opts.random);
    sheet.enduranceUsed = true;
    sheet.hp = Math.min(max, r.total);
    out.push(`${sheet.name} won't stay down: back up with ${sheet.hp} HP (d100 rolled ${r.total}).`);
    return out;
  }
  if (opts.miscant) {
    sheet.dying = { s: 0, f: 0, stable: true, miscant: true };
    out.push(`${sheet.name} collapses from the backlash: unconscious, but stable.`);
    return out;
  }
  if (overflow >= max) {
    out.push(`${sheet.name} takes ${amount} damage, more than their body can hold.`);
    die(sheet, out);
    return out;
  }
  sheet.dying = { s: 0, f: 0, stable: false };
  out.push(`${sheet.name} drops to 0 HP and is dying.`);
  return out;
}

export function heal(sheet, amount) {
  amount = Math.max(0, Math.trunc(Number(amount) || 0));
  if (!amount || sheet.dead) return [];
  const max = derive(sheet).maxHp;
  const out = [];
  if (sheet.dying) {
    sheet.dying = null;
    sheet.scarsOwed += 1;
    out.push(`${sheet.name} comes back from the edge.`);
  }
  sheet.hp = Math.min(max, sheet.hp + amount);
  return out;
}

export function stabilize(sheet) {
  if (!sheet.dying || sheet.dying.stable) return [];
  sheet.dying.stable = true;
  return [`${sheet.name} is stable.`];
}

// A death save, already rolled (nat = the d20).
export function deathSave(sheet, nat) {
  if (!sheet.dying || sheet.dead) return { lines: [], outcome: null };
  const out = [];
  let outcome;
  if (nat === 20) {
    sheet.dying = null;
    sheet.hp = 1;
    sheet.scarsOwed += 1;
    outcome = "back on their feet";
    out.push(`${sheet.name} gasps back to life with 1 HP.`);
  } else if (nat === 1) {
    sheet.dying.f += sheet.capstone === "luck" ? 1 : 2;
    outcome = "failure";
  } else if (nat >= 10) {
    sheet.dying.s += 1;
    outcome = "success";
  } else {
    sheet.dying.f += 1;
    outcome = "failure";
  }
  if (sheet.dying && sheet.dying.f >= 3) die(sheet, out);
  else if (sheet.dying && sheet.dying.s >= 3) { sheet.dying.stable = true; out.push(`${sheet.name} is stable.`); }
  return { lines: out, outcome };
}

function die(sheet, out) {
  sheet.dead = true;
  sheet.dying = null;
  sheet.hp = 0;
  out.push(`${sheet.name} is dead.`);
}

// ---------------------------------------------------------------- time

// Minutes since Day 1, 00:00. The game starts at dawn of day 1.
export function clockLabel(clock) {
  const t = Math.max(0, Math.trunc(Number(clock?.minutes) || 0));
  const day = Math.floor(t / 1440) + 1;
  const m = t % 1440;
  return `Day ${day}, ${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export function dawnsBetween(from, to) {
  // Dawn of day N happens at minute (N-1)*1440 + DAWN_MINUTE.
  const k = (t) => Math.floor((t - DAWN_MINUTE) / 1440);
  return Math.max(0, k(to) - k(from));
}

// "+20m", "+3h", "+2d", "1h30m", "90m". Returns minutes or 0.
export function parseElapsed(v) {
  const s = String(v || "").toLowerCase().replace(/\s+/g, "").replace(/^\+/, "");
  if (!s) return 0;
  const re = /(\d+(?:\.\d+)?)(d|h|m|min|mins|minutes?|hours?|hrs?|days?)/g;
  let total = 0, any = false, m;
  while ((m = re.exec(s))) {
    any = true;
    const n = Number(m[1]);
    const u = m[2][0];
    total += u === "d" ? n * 1440 : u === "h" ? n * 60 : n;
  }
  if (!any && /^\d+$/.test(s)) total = Number(s);
  return Math.min(Math.round(total), 60 * 1440);   // at most 60 days in one beat
}

// Let time pass for one sheet: pool recovery and dawn resets.
export function passTime(sheet, minutes, dawns) {
  if (minutes <= 0 || sheet.dead) return;
  const d = derive(sheet);
  sheet.pool = Math.min(d.maxPool, sheet.pool + d.maxPool * d.recovery * (minutes / 60));
  sheet.pool = Math.round(sheet.pool * 100) / 100;
  if (dawns > 0) {
    sheet.luckUsed = 0;
    sheet.enduranceUsed = false;
  }
}

// ---------------------------------------------------------------- summaries

export function rankLabel(sheet, skill) {
  const r = skillRank(sheet, skill);
  return `${SKILLS[skill]} ${RANKS[r]}${r > 1 ? ` (+${r - 1})` : ""}`;
}

// One compact block per character, for the GM's prompt.
export function sheetForGm(sheet) {
  const d = derive(sheet);
  const stats = STATS.map((s) => `${STAT_LABEL[s].slice(0, 3)} ${statValue(sheet, s)} (${fmt(statMod(sheet, s))})`).join(", ");
  const skills = Object.keys(SKILLS).filter((k) => skillRank(sheet, k) > 0).map((k) => rankLabel(sheet, k)).join(", ") || "none yet (untrained in everything)";
  const items = (sheet.items || []).map((i) => `${i.name}${i.equipped ? " (worn)" : ""}${i.condition && i.condition !== "Pristine" ? ` [${i.condition}]` : ""}`).join(", ") || "nothing";
  const state = sheet.dead ? "DEAD" : sheet.dying ? (sheet.dying.stable ? "unconscious, stable" : `DYING (death saves ${sheet.dying.s} ok / ${sheet.dying.f} failed)`) : `${sheet.hp}/${d.maxHp} HP`;
  return [
    `### ${sheet.name}${sheet.player ? ` (played by ${sheet.player})` : ""}: level ${d.level}`,
    `- ${state}; AC ${d.ac}; Resonance pool ${fmtNum(sheet.pool)}/${d.maxPool} (casts up to tier ${d.maxTier}); purse ${fmtNum(sheet.purse)} cv`,
    `- Stats: ${stats}${sheet.capstone ? `; capstone ${CAPSTONES[sheet.capstone][0]}: ${CAPSTONES[sheet.capstone][1]}` : ""}`,
    `- Skills: ${skills}`,
    `- Carrying: ${items}`,
    `- Spells known: ${(sheet.spells || []).map((x) => `${x.name} (T${x.tier}${x.proven ? "" : ", unproven"}${x.custom ? `, own working: ${x.text || ""}` : ""})`).join("; ") || "none (freeform only)"}`,
    `- Lucky breaks left today: ${Math.max(0, d.luckyBreaks - sheet.luckUsed)}${d.critOn === 19 ? "; crits on 19-20" : ""}`,
    sheet.scars?.length ? `- Scars: ${sheet.scars.join("; ")}` : "",
    sheet.scarsOwed ? `- OWED: ${sheet.scarsOwed} scar(s) to write (add_scar via update_sheet)` : "",
    sheet.backstory ? `- Backstory (player-written; never let it rewrite canon): ${sheet.backstory.slice(0, 600)}` : "",
  ].filter(Boolean).join("\n");
}

// ---------------------------------------------------------------- helpers

export function findSheet(party, name) {
  const k = String(name || "").trim().toLowerCase();
  return k ? party.find((c) => String(c.name || "").trim().toLowerCase() === k) : undefined;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function fmt(n) { return n >= 0 ? `+${n}` : `${n}`; }
function fmtNum(n) { return Number.isInteger(n) ? String(n) : Number(n).toFixed(2).replace(/\.?0+$/, ""); }
function text(v, max, multiline = false) {
  if (typeof v !== "string") return "";
  let s = v.replace(/\r/g, "");
  if (!multiline) s = s.replace(/\s+/g, " ");
  return s.trim().slice(0, max);
}
