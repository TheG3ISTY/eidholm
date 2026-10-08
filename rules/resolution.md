# Eidholm: Rules (Draft 0)

Status: **deliberately unresolved.** These get settled at the table, while playing.
Until a section is marked *Adopted*, the GM resolves things narratively and may propose
mechanics tagged `[PROVISIONAL]`. Anything the table likes gets written here and committed as a `rules:` change.

## Open questions

1. **The Chamber spectrum as aptitude.** Is a character's position between Canting and Artifice their class, a stat, or a slider that moves over a career?
2. **Combat, wounds, scars.** How harm is tracked. Miscants scar per canon, so scars probably need to be a real, lasting thing.
3. **Progression.** XP, milestones, or growth through scars, debts and devotions.

## Adopted

### Dice and chance: D&D 5e, as written

Everything that decides chance follows the D&D 5e rules: d20 tests (ability checks, attack rolls, saving throws) against a DC or Armor Class; ability modifiers and proficiency; advantage and disadvantage; natural 20 and natural 1 on attacks, criticals; passive checks, contests, group checks, initiative; damage dice, resistance and vulnerability; death saving throws; concentration; rerolls; random tables. Character creation is **not** 5e; it is designed separately.

**Who rolls:**
- **The GM asks, players roll.** When a character needs to roll, the GM requests it (type, label, modifier, DC or target AC, damage dice, reasons for advantage or disadvantage). Each request appears as a **button on the left side of that player's screen**, stacked in order. Clicking a button rolls it; **`/roll` rolls all of them in order.** The server rolls with real randomness and everyone sees the result. Rolls can't be taken back.
- **The server judges the result by 5e rules:** advantage and disadvantage cancel each other completely (any of each = a straight roll); checks and saves succeed on meeting the DC; attacks hit on meeting the AC or a natural 20 (critical), and miss on a natural 1; damage is rolled only after a hit, with its dice doubled on a critical.
- **Players see success or failure, not the exact DC or AC.**
- A character who owes the GM a roll can't pass until it's rolled; the GM answers once every present character has acted, passed, or rolled everything owed. Rolls left unrolled when the round resolves lapse, and the GM is told.
- **Until character sheets carry modifiers**, the GM picks a sensible modifier from the character's description. Once they do, the server will read modifiers from the sheet.
- **The idle die** (bottom left, any die from d4 to d100) is for fidgeting while others finish: it rolls only on that player's screen and never counts for anything.
- **The GM rolls for everything else** (NPCs, monsters, hazards, damage it deals, random tables) through a dice tool that returns the server's honest result. The GM narrates from that number and never invents or adjusts one. It never rolls for a player character.
- **The GM's rolls are hidden from players by default**: they see "the GM rolls behind the screen". An unsealed GM always sees every number. **Settings → Show GM rolls to the party** reveals them to everyone while it is on, along with the DCs and Armor Classes behind player rolls. Hidden numbers are never sent to a player's device.
- Every roll, player and GM, is archived with the session transcript.

### Economy and equipment

See [economy.md](economy.md).
