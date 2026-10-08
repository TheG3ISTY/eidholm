// Eidholm dice: honest, server-side randomness for players and the GM.
//
// Expressions:  d20+5   2d6+3   1d8+1d6-1   d100   4d6
// Prefixes:     adv d20+5   dis d20+5   (exactly one d20 in the expression)
//
// rollDice(text) -> {
//   expr:   normalised expression, e.g. "adv 1d20+5"
//   total:  final number
//   parts:  [{ dice: "1d20", rolls: [12, 7], kept: [12], subtotal: 12 } | { mod: 5 }]
//   nat:    20 or 1 when the expression has a single kept d20 that rolled it, else null
//   mode:   "adv" | "dis" | null
// }
// Throws an Error with a readable message on anything it can't roll.

const MAX_DICE = 100;     // per term
const MAX_SIDES = 1000;
const MAX_TERMS = 12;

export function rollDice(text, random = secureRandomInt) {
  let src = String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
  let mode = null;
  const pre = src.match(/^(adv|advantage|dis|disadvantage)\b\s*/);
  if (pre) {
    mode = pre[1].startsWith("adv") ? "adv" : "dis";
    src = src.slice(pre[0].length);
  }
  src = src.replace(/\s+/g, "");
  if (!src) throw new Error("Roll what? Try /roll d20+5");
  if (!/^[+-]?(\d*d\d+|\d+)([+-](\d*d\d+|\d+))*$/.test(src)) {
    throw new Error(`"${text}" isn't a dice expression. Try d20+5, 2d6+3 or adv d20+2.`);
  }

  const terms = src.match(/[+-]?(\d*d\d+|\d+)/g);
  if (terms.length > MAX_TERMS) throw new Error("That's too many terms for one roll.");

  const d20Terms = terms.filter((t) => /^[+]?1?d20$/.test(t));
  if (mode && (d20Terms.length !== 1)) {
    throw new Error("Advantage and disadvantage need exactly one d20, e.g. adv d20+5.");
  }

  const parts = [];
  let total = 0;
  let nat = null;
  let singleD20 = 0;

  for (const raw of terms) {
    const sign = raw.startsWith("-") ? -1 : 1;
    const t = raw.replace(/^[+-]/, "");
    const dm = t.match(/^(\d*)d(\d+)$/);
    if (!dm) {
      const n = Number(t);
      parts.push({ mod: sign * n });
      total += sign * n;
      continue;
    }
    const count = dm[1] === "" ? 1 : Number(dm[1]);
    const sides = Number(dm[2]);
    if (count < 1 || count > MAX_DICE) throw new Error(`Between 1 and ${MAX_DICE} dice per term, please.`);
    if (sides < 2 || sides > MAX_SIDES) throw new Error(`Dice need between 2 and ${MAX_SIDES} sides.`);

    if (mode && count === 1 && sides === 20) {
      const a = random(20), b = random(20);
      const keep = mode === "adv" ? Math.max(a, b) : Math.min(a, b);
      parts.push({ dice: `${sign < 0 ? "-" : ""}1d20`, rolls: [a, b], kept: [keep], subtotal: sign * keep });
      total += sign * keep;
      if (sign > 0) { singleD20++; if (keep === 20 || keep === 1) nat = keep; }
      continue;
    }

    const rolls = Array.from({ length: count }, () => random(sides));
    const sum = rolls.reduce((a, b) => a + b, 0);
    parts.push({ dice: `${sign < 0 ? "-" : ""}${count}d${sides}`, rolls, kept: rolls, subtotal: sign * sum });
    total += sign * sum;
    if (sides === 20 && count === 1 && sign > 0) { singleD20++; if (rolls[0] === 20 || rolls[0] === 1) nat = rolls[0]; }
  }

  // Natural 20 / 1 only means something when exactly one d20 decided the roll.
  if (singleD20 !== 1) nat = null;

  const expr = (mode ? mode + " " : "") + terms
    .map((t, i) => {
      const s = t.replace(/^\+/, "");
      const norm = s.replace(/(^|-)d/, "$11d");
      return i === 0 ? norm : (norm.startsWith("-") ? norm : "+" + norm);
    })
    .join("");

  return { expr, total, parts, nat, mode };
}

// "12+5" style breakdown for display, e.g. "[12, 7]→12 + 5"
export function describeRoll(r) {
  return r.parts.map((p, i) => {
    if ("mod" in p) return (p.mod < 0 ? "− " : i ? "+ " : "") + Math.abs(p.mod);
    const shown = p.rolls.length > 1 && p.kept.length < p.rolls.length
      ? `[${p.rolls.join(", ")}]→${p.kept.join("+")}`
      : p.rolls.length > 1 ? `(${p.rolls.join("+")})` : String(p.rolls[0]);
    return (p.subtotal < 0 ? "− " : i ? "+ " : "") + shown;
  }).join(" ");
}

// Uniform integer in [1, sides] from the platform's cryptographic RNG,
// with rejection sampling so no face is favoured.
export function secureRandomInt(sides) {
  const limit = Math.floor(0x100000000 / sides) * sides;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return (buf[0] % sides) + 1;
  }
}
