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
export const SHIELD_RECOVERY_PER_HOUR = 1 / 24;   // a lattice-shield's pool: empty to full in 24 hours
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

// Armor is worn in five slots, one piece each. Body carries the most.
export const ARMOR_SLOTS = ["head", "hands", "body", "legs", "feet"];
export const ARMOR_AC = {
  light_armor: { head: 0, hands: 0, body: 1, legs: 1, feet: 0 },   // full set +2
  heavy_armor: { head: 1, hands: 1, body: 2, legs: 1, feet: 1 },   // full set +6
};
const piece = (name, armor, slot, extra = {}) => ({ name, kind: "armor", armor, slot, ac: ARMOR_AC[armor][slot], ...extra });

// The starting kit. Armor comes as a set (one pick); `armor` says which skill wearing it trains.
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
  { id: "leather_set", name: "Leather set", kind: "set", armor: "light_armor", ac: 2, pieces: [
    piece("Leather cap", "light_armor", "head"), piece("Leather gloves", "light_armor", "hands"), piece("Leather jack", "light_armor", "body"),
    piece("Leather breeches", "light_armor", "legs"), piece("Leather boots", "light_armor", "feet")] },
  { id: "battered_mail_set", name: "Battered mail set", kind: "set", armor: "heavy_armor", ac: 4, pieces: [
    piece("Battered coif", "heavy_armor", "head"), piece("Battered hauberk", "heavy_armor", "body"),
    piece("Battered chausses", "heavy_armor", "legs")] },
  { id: "lattice_shield", name: "Battered lattice-shield", kind: "shield", skill: "heavy_armor", shieldPool: 500 },
  { id: "medic_satchel", name: "Medic's satchel", kind: "tool", skill: "medicine" },
  { id: "pick_roll", name: "Pick-and-wire roll", kind: "tool", skill: "thievery" },
  { id: "field_kit", name: "Field kit (rope, tarp, flint)", kind: "tool", skill: "survival" },
  { id: "tinker_case", name: "Tinker's case", kind: "tool", skill: "creation" },
  { id: "salvage_gauge", name: "Salvage gauge", kind: "tool", skill: "artifice" },
  { id: "focus_bead", name: "Focus bead", kind: "focus", skill: "canting", focus: 1 },
  { id: "energy_staff", name: "Cracked energy staff", kind: "weapon", skill: "ranged_canting", damage: "1d8", twoHanded: true, quality: "Crude", focus: 1 },
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
// One stat point per level up to 49. Level 50's point is the capstone itself.
export function unspentPoints(sheet) {
  return Math.min(level(sheet), LEVEL_CAP - 1) - 1 - totalStatCost(sheet.stats);
}

// Two hands. A two-handed weapon takes both (one with Titan's grip, the Strength 13
// capstone); a one-handed weapon or a raised shield takes one.
export function handsFor(sheet, item) {
  if (item.kind === "shield") return 1;
  if (item.kind !== "weapon") return 0;
  return item.twoHanded && sheet.capstone !== "strength" ? 2 : 1;
}
export function handsUsed(sheet, except) {
  return (sheet.items || []).filter((i) => i && i.equipped && i !== except).reduce((n, i) => n + handsFor(sheet, i), 0);
}

// What's worn and actually working: a broken item does nothing until it's repaired.
export function equipped(sheet) {
  return (sheet.items || []).filter((i) => i && i.equipped && !i.broken);
}

export function derive(sheet) {
  const lvl = level(sheet);
  const E = plays(statValue(sheet, "endurance"));
  const R = plays(statValue(sheet, "resonance"));
  const armorAc = equipped(sheet).filter((i) => i.kind === "armor").reduce((n, i) => n + (Number(i.ac) || 0), 0);   // one piece per slot
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
    // Resonance ÷ 2, plus the best focus worn or in hand (+1 to +3). Tier 6 is the capstone's alone.
    focus: equipped(sheet).reduce((m, i) => Math.max(m, Math.trunc(Number(i.focus) || 0)), 0),
    maxTier: sheet.capstone === "resonance" ? 6
      : Math.min(5, Math.floor(R / 2) + equipped(sheet).reduce((m, i) => Math.max(m, Math.trunc(Number(i.focus) || 0)), 0)),
    luckyBreaks: Math.max(0, luckMod),
    critOn: statValue(sheet, "luck") >= 9 ? 19 : 20,
    noFumble: sheet.capstone === "luck",
    unspent: unspentPoints(sheet),
    // What a target saves against when this character's spell calls for a save.
    spellDc: 8 + statMod(sheet, "resonance") + skillBonus(sheet, "canting"),
    spellDcRanged: 8 + statMod(sheet, "resonance") + skillBonus(sheet, "ranged_canting"),
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
  if (picks.filter((id) => STARTER_ITEMS.find((x) => x.id === id)?.kind === "set").length > 1) throw new Error("One armor set at most.");
  const items = picks.flatMap((id) => {
    const it = STARTER_ITEMS.find((x) => x.id === id);
    if (!it) throw new Error("One of those items isn't on the starting list.");
    const kit = (x) => ({ tier: 1, quality: x.quality || "Standard", legality: "Legal" });
    if (it.kind === "set") return it.pieces.map((p) => ({ ...p, ...kit(p), equipped: true }));
    const { id: _id, ...rest } = it;
    return [{ ...rest, ...kit(it), equipped: false }];
  });
  for (const i of items) if (i.kind === "focus") i.equipped = true;   // worn: a bead on a cord takes no hand
  for (const i of items) if (i.kind === "shield" && i.shieldPool) i.shieldLeft = i.shieldPool;
  // Weapons and the shield start in hand, as far as two hands allow.
  for (const i of items) if ((i.kind === "weapon" || i.kind === "shield") && handsUsed({ items }, i) + handsFor({}, i) <= 2) i.equipped = true;
  const spellPicks = Array.isArray(input?.spells) ? [...new Set(input.spells.map(String))] : [];
  if (tier1.length && spellPicks.length !== startSpells) throw new Error(`Pick exactly ${startSpells} tier-1 spells.`);
  const spells = spellPicks.map((n) => {
    const sp = tier1.find((x) => x.name.toLowerCase() === n.trim().toLowerCase());
    if (!sp) throw new Error(`"${n}" isn't a tier-1 spell.`);
    return { name: sp.name, tier: 1 };
  });

  const sheet = {
    name,
    player: text(player, 40),
    backstory: text(input?.backstory, 4000, true),
    stats,
    capstone: null,
    skills: {},
    items,
    spells,
    debts: [],
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
  sheet.debts = Array.isArray(sheet.debts) ? sheet.debts.filter((x) => x && x.to && Number(x.amount) > 0) : [];
  for (const i of sheet.items) {
    if (!i) continue;
    if (i.kind === "armor" && !ARMOR_SLOTS.includes(i.slot)) i.slot = "body";   // armor from before slots
    if ("condition" in i) { if (i.condition === "Broken") i.broken = true; delete i.condition; }   // the old condition ladder
    if (i.kind === "shield" && i.shieldPool && !Number.isFinite(i.shieldLeft)) i.shieldLeft = i.shieldPool;
  }
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
  // Holding a spell under pressure: damage calls for an Endurance save (DC 10 or half the damage).
  if (sheet.hp > 0 && sheet.holding) sheet.concentration = Math.max(sheet.concentration || 0, Math.max(10, Math.floor(amount / 2)));
  if (sheet.hp > 0) return out;
  if (sheet.holding) { out.push(`${sheet.name} lets go of ${sheet.holding.name}.`); sheet.holding = null; sheet.concentration = 0; }

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
    // Surviving 0 HP scars, unless a miscant already left its scar for this same fall.
    if (!sheet.dying.scarred) sheet.scarsOwed += 1;
    sheet.dying = null;
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
    // Nobody gets up on their own: a natural 20 only makes them stable. Treatment wakes them.
    sheet.dying.stable = true;
    outcome = "stable";
    out.push(`${sheet.name} holds on: stable, but out cold until someone treats them.`);
    return { lines: out, outcome };
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
  else if (sheet.dying && sheet.dying.s >= 3) { sheet.dying.stable = true; out.push(`${sheet.name} is stable, but out cold until someone treats them.`); }
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
  for (const i of sheet.items || []) {
    if (i && i.kind === "shield" && i.shieldPool && !i.broken) {
      i.shieldLeft = Math.min(i.shieldPool, (Number.isFinite(i.shieldLeft) ? i.shieldLeft : i.shieldPool) + i.shieldPool * SHIELD_RECOVERY_PER_HOUR * (minutes / 60));
      i.shieldLeft = Math.round(i.shieldLeft * 100) / 100;
    }
  }
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
  const items = (sheet.items || []).map((i) => `${i.name}${i.equipped ? (i.kind === "weapon" || i.kind === "shield" ? " (in hand)" : " (worn)") : ""}${i.kind === "shield" && i.shieldPool ? ` [shield ${Math.floor(i.shieldLeft ?? i.shieldPool)}/${i.shieldPool}]` : ""}${i.broken ? " [BROKEN]" : ""}`).join(", ") || "nothing";
  const state = sheet.dead ? "DEAD" : sheet.dying ? (sheet.dying.stable ? "unconscious, stable" : `DYING (death saves ${sheet.dying.s} ok / ${sheet.dying.f} failed)`) : `${sheet.hp}/${d.maxHp} HP`;
  return [
    `### ${sheet.name}${sheet.player ? ` (played by ${sheet.player})` : ""}: level ${d.level}`,
    `- ${state}; AC ${d.ac}; Resonance pool ${fmtNum(sheet.pool)}/${d.maxPool} (casts up to tier ${d.maxTier}); spell save DC ${d.spellDc}${d.spellDcRanged !== d.spellDc ? ` (${d.spellDcRanged} for ranged cants)` : ""}; purse ${fmtNum(sheet.purse)} cv`,
    `- Stats: ${stats}${sheet.capstone ? `; capstone ${CAPSTONES[sheet.capstone][0]}: ${CAPSTONES[sheet.capstone][1]}` : ""}`,
    `- Skills: ${skills}`,
    `- Carrying: ${items}`,
    (sheet.debts || []).length ? `- Debts: ${sheet.debts.map((x) => `${fmtNum(x.amount)} cv to ${x.to}${x.terms ? ` (${x.terms})` : ""}${x.missed ? `; failed collections: ${x.missed}` : ""}${x.collectorKilled ? "; a collector was killed" : ""}`).join("; ")}` : "",
    `- Spells known: ${(sheet.spells || []).map((x) => `${x.name} (T${x.tier}${x.custom ? `, own working: ${x.text || ""}` : ""})`).join("; ") || "none (freeform only)"}`,
    `- Lucky breaks left today: ${Math.max(0, d.luckyBreaks - sheet.luckUsed)}${d.critOn === 19 ? "; crits on 19-20" : ""}`,
    statValue(sheet, "luck") <= 3 ? "- Bad luck: once per session, you may turn one of their successes into a complication (a cost, never a failure)." : "",
    sheet.scars?.length ? `- Scars: ${sheet.scars.join("; ")}` : "",
    sheet.scarsOwed ? `- OWED: ${sheet.scarsOwed} scar(s) to write (add_scar via update_sheet)` : "",
    sheet.holding ? `- HOLDING: ${sheet.holding.name} (one lasting spell at a time; release it with update_sheet release when its duration runs out)` : "",
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
