# Eidholm: Characters

<!-- dev -->
Status: **adopted.** The server enforces everything here: it keeps the live sheets during play, does the arithmetic, and writes them back to `characters/party.json` on Save and End.
<!-- /dev -->

There are **no classes**, and the Chamber spectrum (Canting ↔ Artifice) is **not tracked** on the sheet: a character is what their stats and skills say, and the world reacts to what they do.

## Stats: S.P.E.C.I.A.L. + R

Eight stats, each from 1 to 10.

| Stat | Replaces 5e's | Used for |
|---|---|---|
| **Strength** | Strength | lifting, grappling, melee damage, athletics |
| **Perception** | Wisdom (noticing) | noticing, insight, survival, ranged accuracy |
| **Endurance** | Constitution | hit points, poison, exhaustion, holding a spell under pressure |
| **Charisma** | Charisma | persuasion, deception, intimidation, performance |
| **Intelligence** | Intelligence | knowledge, investigation, medicine, Artifice |
| **Agility** | Dexterity | stealth, reflexes, Armor Class, initiative, finesse, blocking |
| **Luck** | none | never rolled on its own: rerolls, critical range, fortune |
| **Resonance** | none | Canting: how much Lattice a mind can carry; resisting another's cant |

**Saving throws:** Strength, Agility, Endurance, Intelligence, Perception, Charisma, and Resonance (against cants and Lattice effects). Luck never saves.

### Modifiers

**Modifier = stat − 5.** A 5 is +0; a 1 is −4; a 9 is +4.
**A 10 plays as an 11:** modifier +6, not +5.

### Allocation at creation

- Every stat starts at **5**. There are **no free points**: creation is a pure trade.
- Raising a stat costs 1 point per step; lowering one refunds 1, down to a floor of **1**.
- **The step from 9 to 10 costs 2.**
- So taking one stat from 5 to 10 costs 6 points, and maxing two stats means gutting everything else.

### Levels and the capstone

- **Levels come from skills: 1 level for every 2 skill ranks gained.** Level cap: **50**, reached at 98 ranks.
- **1 stat point per level**, up to level 49. Level 50 gives the capstone instead of a point.
- Because creation is zero-sum, every character needs exactly **48 points** to max all eight stats: reached at **level 49**, whatever their build.
- **Level 50, the capstone:** choose **one stat to raise to 13** (modifier +8). Each 13 also grants one ability:

| Capstone | Name | Ability |
|---|---|---|
| **Strength 13** | Titan's grip | Wield two-handed weapons in one hand, **and the free hand may hold a shield.** The heavy frontliner: hits like a two-hander, blocks like a shield-bearer, but without an Endurance build's staying power. |
| **Perception 13** | No blind side | Never surprised or flanked; a shield can be raised and blocks made against attacks from any direction. |
| **Endurance 13** | Won't stay down | Once per in-game day, dropping to 0 HP instead returns you to **d100 HP** (never above your maximum). Immune to exhaustion. |
| **Charisma 13** | Your word is law | Once per scene, order a non-pillar NPC to take one action; they obey unless it would kill them. Pillars and the Final Notice are never bound. |
| **Intelligence 13** | Masterwork | The true artificer: everything you make with Creation comes out **one quality step above** what the roll gave (Crude → Standard → Fine → Exceptional → **Masterwork**). Masterwork quality exists only through this capstone: nothing else makes it. You also work any lattice device on first touch with no skill penalty. |
| **Agility 13** | Pinpoint | Once per combat encounter, **choose the face of every die** in one of your attacks, however many dice it has. A chosen 20 is a natural 20. |
| **Luck 13** | Never fumble | No critical failures: a natural 1 is just a 1 (it adds your modifier and can still miss), never an automatic miss, and **a natural 1 never miscants.** It removes the critical failure only: the wider miscant range of a freeform cant's first cast still applies, and the d8 for learning by casting has no critical failure to remove. |
| **Resonance 13** | Tier 6 | The only way to cast **tier 6** spells. Nothing else unlocks them: no focus, device, gear, ritual, assist or mind of glass. |

## Derived numbers

All are recalculated from the **current** sheet (raising Endurance raises HP for every level already gained). **E** below is Endurance as it plays (10 = 11, capstone 13 = 13).

| Derived | Formula |
|---|---|
| **Hit points** | **8 + 2 × E + (level − 1) × ⌈E ÷ 2⌉** |
| **Armor Class** | 10 + Agility modifier + every armor piece worn |
| **Initiative** | Agility modifier; Perception breaks ties |
| **Carry limit** | Strength × 10 kg |
| **Melee damage** | + Strength modifier |
| **Ranged accuracy** | + Perception modifier |

| Endurance (plays as) | Per level | Level 1 | Level 10 | Level 25 | Level 50 |
|---|---|---|---|---|---|
| 1 | +1 | 10 | 19 | 34 | 59 |
| 5 | +3 | 18 | 45 | 90 | 165 |
| 9 | +5 | 26 | 71 | 146 | 271 |
| 10 (11) | +6 | 30 | 84 | 174 | 324 |
| 13, capstone | +7 | 34 | | | 377 |

## Luck

- **Lucky breaks:** rerolls per in-game day equal to the Luck modifier (none at 5, three at 8). Any d20 you roll, or one rolled **against** you, can be rerolled; the new result stands.
  - **Your own rolls:** a *Lucky break* button sits on each of your d20 rolls for the rest of the round. If yours is the roll that completes the round, the GM waits **10 seconds** before answering (or until you press *Keep it*), so the chance is real.
  - **Rolls against you:** say in your action that you spend one ("if that blow lands, I spend a lucky break"); the GM rerolls it and the break is spent.
- **Critical range:** at Luck 9 and up, attacks crit on 19 or 20. That is the ceiling for everyone.
- **Fortune:** the GM leans random tables, loot and chance encounters by Luck.
- **Bad luck:** at Luck 3 or below, once per session the GM may turn a success into a complication (a cost, never a failure).
- **Capstone (13):** no critical failures, ever (see above).

## Resonance and Canting

**Resonance is capacity, not risk.** A strong Canter casts more, not more dangerously.

| | |
|---|---|
| **Pool** | Resonance × 4 (a 10 holds 44; a 13 holds 52) |
| **Recovery** | **12.5% of the maximum pool per in-game hour**, rest or no rest (empty to full in 8 hours) |
| **What raises what** | Resonance raises the pool only. Gear can raise the pool **and** the recovery rate. Gear never raises the Resonance stat itself. |
| **Spell cost** | tier 1: 2 · tier 2: 4 · tier 3: 8 · tier 4: 14 · tier 5: 22 · **tier 6: 39** |
| **Highest tier** | Resonance ÷ 2, rounded down, **plus the best focus worn or in hand**: a Common focus +1, Guild +2, Superior +3 (so a Resonance 2–3 canter casts tier 1 with a bead). Never above tier 5. **Tier 6: Resonance 13 only, period**; no focus opens it. |

### Miscants

A **natural 1** on a Canting roll is a miscant. Freeform cants and learning by casting carry wider ranges: see the **Spells** page. Backlash depends **only on the spell's tier**, never on the caster's Resonance:

| Tier | Backlash |
|---|---|
| 1 | 1d4 |
| 2 | 2d6 |
| 3 | 4d6 and a **scar** |
| 4 | 6d8 and a scar |
| 5 | 8d10 and a scar |
| 6 | 10d12 and a scar |

**A miscant never kills outright.** If backlash drops a character to 0 HP, they are unconscious and **automatically stable** (no death saves). Only something else in the scene can finish them.

## Skills

**Stats are what you are; skills are what you've learned.** Anyone can attempt a stat check (smashing a door is Strength). Skills cover weapons, armor, crafts and disciplines: everyone starts **untrained in all of them**, and they **grow only through use** (wear heavy armor through enough fights and you get better in heavy armor).

| Fighting | Defense | Lattice | Life |
|---|---|---|---|
| Small melee (daggers, batons; always one hand) | Heavy armor (**including shields**) | Canting (wards, mending, utility, control) | Survival |
| Medium melee (swords, maces; one or two hands) | Light armor | Ranged canting (energy staves and the like) | Medicine |
| Large melee (greatswords, halberds; two hands) | Unarmored combat (fighting well **without armor**) | Artifice (operating devices, arrays, skiffs, salvage rigs) | Creation (smithing, alchemy and enchanting in one) |
| Ranged, non-canting (bows, crossbows, thrown) | | | Thievery (locks, sneaking, pickpocketing) |
| | | | Performance (speech, persuasion, presence) |

**Firearms are cut** from the game, as a skill and as personal weapons: too hard to balance. The canon's guns are read as **emplaced artillery** (the Bastion's gun-decks), and its bayonets sit on **canting-lances**.

### Ranks

A skill check is **d20 + skill bonus + stat modifier.** The best possible bonus is +12 (a 10 stat and a Legend skill).

| Rank | Name | Bonus | Marks to reach |
|---|---|---|---|
| 0 | Untrained | +0 | |
| 1 | Familiar | +0 | 1 |
| 2 | Novice | +1 | 2 |
| 3 | Trained | +2 | 4 |
| 4 | Adept | +3 | 8 |
| 5 | Expert | +4 | 16 |
| 6 | Master | +5 | 32 |
| 7 | Legend | +6 | 64 |

Marks reset after each rank-up; taking one skill from Untrained to Legend costs **127 marks**.

- **Untrained is allowed, armor excepted:** anyone can swing a sword at rank 0, but wearing armor you are **Untrained** in gives **disadvantage on Agility rolls and on Canting.** Familiar (one mark) lifts it.

### Learning by use

- Every roll the GM asks for is tagged with its skill. A roll with a real stake earns that skill a **mark, pass or fail.**
- Rolls you make unasked, and the idle die, earn nothing.
- **One mark per skill per scene at most.** Ten swings in one fight count once; ten fights count ten times. A new place, a fight breaking out, or a fight ending starts a new scene.
- **What you wear trains in a fight:** once per fight, at the end of the first round you roll in, your worn armor's skill earns its mark (a raised shield trains Heavy armor; no armor at all trains Unarmored combat). It comes after that round's rolls, so the untrained penalty is felt first. One fight never carries a skill more than one mark forward.
- Use alone carries a skill all the way to Legend. No teachers, no gates.
- The game counts the marks itself; nobody keeps score by hand.

### At creation

**Every skill starts at 0.** Characters begin untrained in everything; skills are only ever learned in play.

### Which stat a roll uses

The GM names a stat and (if one fits) a skill for every roll it asks for; the game adds both bonuses from the sheet.

- **Melee attacks:** Strength (Agility for daggers and other finesse weapons); melee damage adds the Strength modifier automatically.
- **Ranged attacks:** Perception. **Cants:** Resonance. **Blocking with a shield:** Agility + Heavy armor.
- **Checks and saves:** whichever stat the moment calls for. Luck is never rolled.

## Armor

Armor is worn in **five slots: head, hands, body, legs, feet**, one piece each. Every piece is **light** or **heavy**:

| Slot | Light piece | Heavy piece |
|---|---|---|
| Body | +1 | +2 |
| Legs | +1 | +1 |
| Head | +0 | +1 |
| Hands | +0 | +1 |
| Feet | +0 | +1 |
| **Full set** | **+2** | **+6** |

- Pieces can be mixed. Each trains its own skill (Light armor or Heavy armor), and each untrained weight class worn gives **disadvantage on Agility rolls and Canting** until it's Familiar.
- Wearing a new piece takes off whatever was in that slot.

## Lattice-shields

Shields are **held, never worn.** A shield needs a hand, a direction, and a moment of attention, so no build can stack a two-handed weapon with a shield. The single exception is the **Strength 13 capstone** (Titan's grip).

**Two hands.** What a character holds is marked on the sheet (*Take up* / *Put away*): a two-handed weapon takes both hands, a one-handed weapon or a raised shield takes one, and nothing more fits. Titan's grip makes a two-handed weapon take one hand. Starting weapons and shields are in hand, as far as two hands allow.

- **Against ranged attacks (cants and projectiles alike):** a **raised** shield (in hand) absorbs everything coming from the direction it faces, into its own pool of **500 to 1,500**, by quality. When the pool is spent, it **shatters**: broken until repaired, then full again. Smashing a real shield takes a sustained barrage: rare and dramatic.
- **The pool refills by itself:** 1/24 of it per in-game hour (about 4.17%), so empty to full takes a day. A shattered shield doesn't refill until it's repaired.
- A shield at your side does nothing; **attacks from the flank or behind go straight through.** Keeping it raised costs a hand and slows you as if heavily laden.
- **Against melee, the block:** once per round, an aware shield-bearer may roll **d20 + Agility modifier + Heavy armor skill** against the attack's total. Win: the blow lands on the shield's pool instead. Lose: it gets past.
- **Blocking a small melee weapon is at disadvantage**: daggers slip past shields.
- **No block** when surprised, grappled, or attacked from behind.
- Shields roll into the **Heavy armor** skill.

## Origin

**Players write their own backstory**: where they come from, who they served, what they believe. Nothing on the sheet comes from it; the GM reads it and plays the world accordingly.

- Players who'd rather not write one can **start from a preset** (the dropdown on the creation screen, from `world/backstories.md`) and edit it as much or as little as they like.

- A backstory can tie into any faction or faith, but it **cannot rewrite canon**: no secret child of a pillar, no inherited bank seat, no knowing what the Rim is. The GM keeps what fits and quietly bends what doesn't.

## Starting kit

A fresh character starts with **50 cv**, clothes, a pack, and **3 items** of their choice from this list (all Common, tier 1):

| Weapons | Armor | Tools |
|---|---|---|
| Dagger (small melee) | Leather set (light: all five slots) | Medic's satchel (Medicine) |
| Baton (small melee) | Battered mail set (heavy: body, legs, head) | Pick-and-wire roll (Thievery) |
| Sword (medium melee) | Battered lattice-shield, pool 500 (heavy armor) | Field kit: rope, tarp, flint (Survival) |
| Mace (medium melee) | | Tinker's case (Creation) |
| Greatsword (large melee) | | Salvage gauge (Artifice) |
| Halberd (large melee) | | Focus bead (Canting; focus +1, worn) |
| Bow, crossbow or throwing knives (ranged) | | Cracked energy staff (Ranged canting; focus +1, two hands) |

Every item points at a skill: what you carry is where you start learning.

**Two tier-1 spells**, picked at creation from the spellbook: learned, like any spell on the sheet.

- **Armor:** an armor set is **one pick**, and only one set can be picked. The **leather set** is complete light armor, +2 AC. The **battered mail set** is heavy and incomplete, +4 AC (coif, hauberk and chausses, old and dented but whole): the gloves and boots that finish it are found in play. Worn from the start.
- **Weapons:** dagger, baton and throwing knives 1d4; mace and bow 1d6; sword, crossbow and the cracked energy staff 1d8; halberd 1d10; greatsword 2d6. Greatswords, halberds, bows, crossbows and staves need two hands.
- The kit is picked on the **creation screen**, along with stats and backstory. The GM never builds a sheet.

## Dying

At **0 HP** a character falls **unconscious** and makes **death saves**, as 5e:

- At the start of each of their turns, roll **d20**: 10 or higher is a success, 9 or lower a failure.
- **Three successes:** stable. **Three failures:** dead.
- **Natural 20:** stable at once. **Natural 1:** two failures (not with **Luck 13**: there it is one).
- Taking damage at 0 HP is one failure; a critical hit is two.
- **Massive damage:** if the damage left over after hitting 0 equals or exceeds maximum HP, death is instant.
- Anyone can stabilise a dying character with a **Medicine** check, DC 10.
- **A dying character whose player leaves the table** (marked absent) counts as stabilised: no death saves, out cold until treated.
- **Nobody gets up on their own.** A stable character stays unconscious until they're **treated**: a healing spell, or a medic's care. Any healing brings them back with that many HP.
- **Endurance 13** (Won't stay down) triggers before any of this, once per in-game day.
- A dying character is asked for a death save **every round**, automatically.
- **Miscants** follow their own rule: unconscious and automatically stable, no death saves.

**Every drop to 0 that a character survives leaves a scar.**

## Scars

Scars come from **surviving a drop to 0 HP** and from **miscants of tier 3 and up**. One event leaves one scar: a miscant whose backlash also drops the caster to 0 scars them once. They are **pure story**: no penalty, no bonus. The GM writes each one to fit how it happened, it goes on the sheet for good, and the world reacts to it: NPCs notice, remember, and judge.

## The clock

The world keeps one clock: **day, hour and minute**, shown at the top of the screen.

- **The GM moves it** as the story goes: a fight is minutes, a march is hours.
- **The game does the rest:** Resonance pools refill at 12.5% of maximum per hour (pro rata, so 30 minutes is 6.25%), and every "per in-game day" ability resets **at dawn**: lucky breaks, Won't stay down, and anything else that counts days.
- Time never runs backwards. If the GM corrects the clock, refills that already happened stay.

<!-- dev -->
- The GM reports elapsed time in the hidden scene tag every turn (`time=+20m`, `time=+3h`, `time=+2d`); a human GM uses the time box on the GM desk.
- The owner can set the clock directly in the unsealed Party tab. Forward counts as time passing; back takes nothing back.
<!-- /dev -->
