# WuWa Rotation DPS

Total damage for a Wuthering Waves rotation, computed in the browser. No login, no server.

**Run it:** https://racinel200.github.io/Wuwu/

Pick a rotation, hit **Run**, read the number. Tick buffs on and off to A/B without editing
anything — the page shows the delta against your previous run.

---

## The three files

| file | what it holds | who edits it |
|---|---|---|
| `data/characters.json` | every build — level, weapon, echoes with all substats — plus each character's buff catalogue and their in-game panel readings | you, or any chat |
| `data/rotations.json` | rotations: a team, the buffs that are live, and an ordered list of steps | you, or any chat |
| `index.html` | the runner | nobody, normally |

Everything else is machinery: `engine.js` is the damage model, `ref/` is reference data
pulled from arabwuwa, `tools/` holds the regression and a refresh script.

## Editing

Both data files carry a `_howToEdit` block at the top explaining their own format, so a
chat that has never seen this repo can open one file and know what to do.

Two guard rails keep bad edits from producing quietly wrong numbers:

**The build check.** Each character records their in-game panel readings. On every run the
page recomputes those stats from the build data alone and shows a badge. Green means the
engine reproduces your character panel exactly. A fat-fingered substat turns it red.

**Loud failures.** An ability name that does not exist, a buff id that does not resolve, a
step naming someone outside the team — all surface as warnings at the top of the page
instead of silently contributing zero.

## Rotations

A rotation is one long list of steps in the order you press things, switching characters
freely:

```json
{ "char": "aemeath", "ability": "Heavenfall Edict: Finale DMG", "count": 1, "note": "the payoff" }
```

`ability` must match the label in `ref/proj-<char>.json` exactly. The page lists every valid
label per character under **Ability names**.

`count` repeats a step. `crit` can be `"average"` (default), `"noncrit"` or `"crit"`.
`raw` injects a fixed number instead of computing one — used for main-echo damage, which the
reference data does not carry.

`buffs` lists ids from `characters.json`. A buff reaches a character only if it is
`target: "team"` or owned by them. Delete an id to test without it.

## The model

A faithful reimplementation of the arabwuwa calculator, derived by reading
`api/calculator-runtime.php?artifact=route-calculator` — the 360 KB module that holds the
actual math, not the `artifact=core` bundle, which is only the UI shell. Nothing is fitted.

There are **three** damage paths, dispatched on the ability's `scaling` field.

**1. ATK / HP / DEF scaling** — ordinary abilities.

```
noncrit = MV × stat
        × (1 + Σ dmgBonus)     element + attack-type + all-attribute, additive
        × (1 + Σ amplify)      amplify / deepen, a separate multiplicative bucket
        × defMult × resMult × (1 + vulnerability)
```

Crit DMG is a multiplier, not a bonus: 282.8% means ×2.828.

```
crit    = noncrit × critDmg
average = noncrit × (1 + critRate × (critDmg − 1))
```

A sequence node reading "DMG Multiplier is increased by 100%" **doubles** the MV
(Finale 1309.59% → 2619.18%); it does not add 100 percentage points.

DEF ignore and RES shred are attack-type scoped. Everbright Polestar's 32% DEF ignore and
10% Fusion RES reduction hit Liberation damage only.

**2. Negative status** — `fusionBurst`, `spectroFrazzle`, `aeroErosion`, `electroFlare`,
`havocBane`, `glacioChafe`, `glacioBite`. **Does not use ATK at all.**

```
mvEff   = (MV + addMV) × (1 + mvPct) × (1 + mvMult)
noncrit = STATUS_LEVEL_TABLE[charLvl] × mvEff
        × (1 + amplify) × (1 + dmgBonus) × (1 + vulnerability)
        × defMult × resMult
```

`defIgnore` is forced to 0. RES reduction is refused outright for `fusionBurst`. Only buffs
whose `attackType` names the status feed these buckets, and a `dmgBonus` must also be
element-agnostic — so a generic Fusion DMG bonus, a team ATK buff and an outro amplify all
contribute nothing here.

**3. Tune Break system.**

```
base    = 716.22 × 14 × (1 + tuneBreakPoints/100) × tuneAmpFraction
noncrit = base × (1 + amplify) × (1 + dmgBonus) × (1 + vulnerability) × defMult × resMult
```

Shared by all three:

```
defMult = A / (A + D × (1 − defRed) × (1 − defIgnore))
          A = 800 + 8·charLvl,   D = 792 + 8·enemyLvl
N = res − resShred;   resMult = max(0, N ≥ 0 ? 1 − N : 1 − N/2)
```

## Verifying

```
node tools/validate.mjs
```

Reproduces a 29-ability fixture captured off arabwuwa on 2026-08-12, **exact to the
displayed integer on all 29**, across all three damage paths. Plus five isolation steps that
vary one Fusion Burst toggle at a time on a bare character, proving the status path never
touches ATK. Then it runs the panel check and every rotation, failing on any warning.

The regression pins its own parity config — level, talents, forte nodes and echoes are all
frozen inside `validate.mjs` — so editing your build never breaks it. This was NOT true until
2026-08-19: the fixture had been inheriting each of those four fields from the live build in
turn, and levelling a character made 29 abilities "fail" by an identical percentage when
nothing about the engine had changed. If a field can be changed by playing the game, the
fixture must set it explicitly.

## Two things arabwuwa cannot do

**Weapon level.** The site hard-codes every weapon to Lv90. `weapon.atkOverride` and
`weapon.subOverride` take the real values — Everbright Polestar at Lv70 solves to
Base ATK 449.4 / Crit Rate 20.0% against 587 / 24.3% at Lv90.

**Ascension.** The site's stat rows are post-ascension values. `baseScale` handles a character
sitting at a level cap *pre*-ascension. Current factors: **Aemeath 0.94475 and Suisui 0.9433 at
Lv80**, both fitted against their real panels (Aemeath's weighted on ATK, since ATK is what the
damage model consumes). At Lv70 they were 0.9342 and 0.9351.

A single scalar **cannot** reconcile ATK, HP and DEF exactly — the game keeps its own
pre-ascension base rows rather than a uniform fraction of the post-ascension ones, so a residual
of a few points is structural. Where a character has a real panel reading, that panel is
authoritative and the reconstruction is only a cross-check.

Together these are why the site overstates Aemeath's ATK by about 16%.

## Refreshing reference data

After a game patch:

```
bash tools/refresh-ref.sh
node tools/validate.mjs
```

If the regression still passes, the model survived the patch. If it fails, arabwuwa changed
something and the deltas will point at what.

## Known gaps

- Only Aemeath is reconciled against her in-game panel. Suisui, Verina, Augusta and Mortefi
  run at reference defaults (weapon at Lv90) — fine for comparing options, not for matching
  the game.
- Augusta's panel Crit Rate is 61.3% but her build only accounts for 51.3%. The missing 10
  points are either Thunderflare Dominion's Lv70 substat or forte nodes she has unlocked.
- Baizhi was never captured.
- Echo-skill damage is not in the reference data; use a `raw` step.
- The Fusion Burst hit count per rotation is an estimate. Count them in-game and correct it.
