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

### Remembering people

The GM improvises minor NPCs freely. It **flags someone as important**, and keeps them in `campaign/cast.json`, the moment any of these is true:

1. **Ledger:** a debt, favor, promise, contract or Exchange deal ties them to a character.
2. **Blood:** they hurt a character, were hurt by one, or survived a fight with the party.
3. **Secrets:** they know something about a character, or hold a piece of the plot.
4. **Office:** they hold real power in a faction, including any bank enforcer assigned to a character's debt.
5. **Minds of glass** that pledged themselves to, or were hired by, a character.
6. **The players care:** a player asks about them again, goes looking for them, or flags them with **`/remember name`**.
7. **They come back:** a named NPC met in a second, separate scene.

Never flagged: one-off shopkeepers, crowds, unnamed guards, people the party walked past. (Small property changes hands constantly in Eidholm, so a new face behind a familiar counter needs no explanation.)

**What's kept:** name, role, faction, where to find them, a line of look and voice, attitude toward the party, ledger, and, for the GM only, what they want, their secret, and notes.

**Status:** *active* (read in full every turn), *dormant* (unseen for 3 sessions; one line, wakes up when they reappear), *dead* (one line, kept forever).

**Who sees what:** players see the People tab in the Codex with the public half; wants, secrets and notes are GM-only and never sent to a player's device. Remembered people are written to the repo at Save and End session.

### Fixed figures

Twenty-five canon-level NPCs are kept in `campaign/cast.json` as **pillars**: they never go dormant, and the GM keeps them consistent forever. Each has a public face (role, where, look) and a GM-only layer: what they want, their secret, the contradiction that cuts against their role, and how they treat the party.

- **Combine Concord:** Chair Ottilie Kaldren, High Maintainer Severin Graul, Registrar Ilse Marrow, Holdmother Brann of Deephold Varek, Calder (Kalvane's Cathedral Mind)
- **Verdant League:** Speaker Aurelio Vant, First Dream-Reader Ysmay of the Hollowwood, Master Livia Serrat of the Dueling Courts, Rector Benedek Orrin, Keeper Nella Quint
- **Sorrow Flotillas:** Salvage Master Odalys Crane, Hierophant Sabbe Thole, Master Diver Hesper Rook, Helmswoman Imke Sarrow
- **The Custodians** (vow-names, no family names): Lord Castellan Hadrien, Keeper Ansgar, Reader Merit
- **The Unchained Court** (deliberately vague; the GM defines them on first contact): the Warlord, the Ambassador, the Philosopher
- **The bank:** the Senior Partner (a title only), the Final Notice (the chief enforcer: a fact, not a character; can be outrun, never stopped, never stops)
- **The Choir Eternal:** Precentor Odile Verane, Registrar-General Tobiah Fenn, Inquisitor Cassia Dorn

**The Rim has no fixed figures, by design.** The GM never invents a leader, seat or explanation for the Archive; encounters leave more questions than answers; deletions are felt, never traced.

### Economy and equipment

See [economy.md](economy.md).
