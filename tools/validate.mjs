/*
 * Regression: prove engine.js still reproduces arabwuwa exactly.
 *
 *   node tools/validate.mjs
 *
 * The fixture was captured off https://arabwuwa.com/calculator/ on 2026-08-12 with
 * Aemeath Lv70 S3 / Everbright Polestar R1 / skills 6-6-6-6-6 / Trailblazing Star 5-5,
 * Suisui + Verina in Team Buffs, enemy Lv100 at 20% RES.
 *
 * This deliberately builds its OWN parity config rather than reading the account-accurate
 * settings out of data/characters.json — so editing your build never breaks the regression.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Engine } from '../engine.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

// ---------------------------------------------------------------- the fixture

const STATS = { atk: 2612, hp: 15117, def: 1017, critRate: 59.90, critDmg: 282.80 };

const ABILITIES = {
  'Basic Attack - Aemeath Stage 1 DMG': 916,
  'Basic Attack - Aemeath Stage 2 DMG': 1373,
  'Basic Attack - Aemeath Stage 3 DMG': 1841,
  'Basic Attack - Aemeath Stage 4 DMG': 2661,
  'Heavy Attack - Aemeath Charged I DMG': 7600,
  'Heavy Attack - Aemeath Charged II DMG': 18991,
  'Mid-air Attack - Aemeath DMG': 1706,
  'Dodge Counter - Aemeath DMG': 5143,
  'Sync Strike: Armament Merge DMG': 2651,
  'Sync Strike: Call of Dawn DMG': 3216,
  'Basic Attack - Mech Stage 1 DMG': 1376,
  'Basic Attack - Mech Stage 2 DMG': 1835,
  'Basic Attack - Mech Stage 3 DMG': 2304,
  'Basic Attack - Mech Stage 4 DMG': 2661,
  'Heavy Attack - Mech Charged I DMG': 7598,
  'Heavy Attack - Mech Charged II DMG': 18991,
  'Mid-air Attack - Mech DMG': 1706,
  'Dodge Counter - Mech DMG': 5605,
  'Heavenfall Edict: Overdrive DMG': 47378,
  'Heavenfall Edict: Finale DMG': 142158,
  'Seraphic Duet: Encore DMG': 24128,
  'Seraphic Duet: Overture DMG': 24132,
  'Songs Across the Universe DMG': 2546,
  'Debut of Meteoric Radiance DMG': 3089,
  'Fusion Burst Hit (10 stacks)': 17985,
  'Fusion Burst Hit (11 stacks)': 23980,
  'Fusion Burst Hit (12 stacks)': 29975,
  'Tune Rupture Response - Starburst DMG': 17746,
  'Seraphic Duet Bonus DMG (Per Instance)': 3254,
};

// Fusion Burst isolated on a BARE Aemeath Lv70 — no echoes, no weapon, no teammates.
// Each row adds one toggle on the live site. Proves the status path never touches ATK.
const STATUS_STEPS = [
  ['bare Lv70', 0, 2588],
  ['+ Fusion Trail Stacks Removed = 13', 130, 5952],
  ['+ Stardust Resonance (passive)', 330, 11127],
  ['+ S2 Stardust Extra Multiplier 200%', 530, 16303],
  ['+ S2 per-Fusion-Trail-stack (13)', 595, 17985],
];

const HEAVIES = ['Heavy Attack - Aemeath Charged I DMG', 'Heavy Attack - Aemeath Charged II DMG',
  'Heavy Attack - Mech Charged I DMG', 'Heavy Attack - Mech Charged II DMG'];

// ---------------------------------------------------------------- harness

function loadEngine(charactersOverride) {
  const projections = {};
  for (const f of readdirSync(join(ROOT, 'ref'))) {
    const m = /^proj-(.+)\.json$/.exec(f);
    if (m) projections[m[1]] = read(`ref/${f}`);
  }
  const ref = {
    projections,
    weapons: read('ref/weapons.json'),
    sonata: read('ref/sonata-sets.json'),
    statusLevels: read('ref/status-level-table.json'),
  };
  return new Engine(ref, charactersOverride, read('data/rotations.json'));
}

/** arabwuwa parity: weapon at Lv90, no ascension scaling, 5-piece conditional OFF. */
function parityBuffs() {
  return [
    { id: 'p.2pc', target: 'self', kind: 'stat', stat: 'elemDmg:fusion', value: 10 },
    { id: 'p.sig', target: 'self', kind: 'stat', stat: 'libDmg', value: 25 },
    { id: 'p.wpn', target: 'self', kind: 'stat', stat: 'attrDmg', value: 12 },
    { id: 'p.floral', target: 'self', kind: 'stat', stat: 'attrDmg', value: 9.8 },
    { id: 'p.s3cd', target: 'self', kind: 'stat', stat: 'critDmg', value: 60 },
    { id: 'p.verina', target: 'self', kind: 'stat', stat: 'atkPct', value: 20 },
    { id: 'p.herald', target: 'self', kind: 'stat', stat: 'atkPct', value: 20 },
    { id: 'p.trace', target: 'self', kind: 'stat', stat: 'atkPct', value: 24.9 },
    { id: 'p.amp', target: 'self', kind: 'amplify', value: 40, attackType: 'all' },
    { id: 'p.finaleamp', target: 'self', kind: 'amplify', value: 25, abilities: ['Heavenfall Edict: Finale DMG'] },
    { id: 'p.heavyamp', target: 'self', kind: 'amplify', value: 200, abilities: HEAVIES },
    { id: 'p.heavycd', target: 'self', kind: 'abilityCritDmg', value: 300, abilities: HEAVIES },
    { id: 'p.defign', target: 'self', kind: 'defIgnore', value: 32, attackType: 'liberation' },
    { id: 'p.resred', target: 'self', kind: 'resRed', value: 10, element: 'fusion', attackType: 'liberation' },
    { id: 'p.finalemv', target: 'self', kind: 'mvPct', value: 100, abilities: ['Heavenfall Edict: Finale DMG'] },
    { id: 'p.odmv', target: 'self', kind: 'mvPct', value: 40, abilities: ['Heavenfall Edict: Overdrive DMG'] },
    { id: 'p.ovmv', target: 'self', kind: 'mvPct', value: 100, abilities: ['Seraphic Duet: Overture DMG'] },
    { id: 'p.enmv', target: 'self', kind: 'mvPct', value: 100, abilities: ['Seraphic Duet: Encore DMG'] },
    { id: 'p.fb', target: 'self', kind: 'status', status: 'fusionBurst', bucket: 'mvPct', value: 130 + 200 + 200 + 65 },
  ];
}

let failures = 0;
const fail = (msg) => { failures++; console.log(`  FAIL  ${msg}`); };

// ---------------------------------------------------------------- run

const chars = read('data/characters.json');
const parityChars = JSON.parse(JSON.stringify(chars));
const a = parityChars.characters.aemeath;
delete a.baseScale;
delete a.weapon.atkOverride;
delete a.weapon.subOverride;
a.buffs = [];

const eng = loadEngine(parityChars);
const state = eng.buildState('aemeath', parityBuffs());
const abilityMap = eng.abilities('aemeath');
const enemy = { level: 100, res: Object.fromEntries(['fusion', 'glacio', 'electro', 'aero', 'spectro', 'havoc'].map(e => [e, 20])) };

console.log('STAT CHECK (arabwuwa parity config)');
const statGot = { atk: state.atk, hp: state.hp, def: state.def, critRate: state.stats.critRate, critDmg: state.stats.critDmg };
for (const [k, want] of Object.entries(STATS)) {
  const got = statGot[k];
  const ok = Math.abs(got - want) < (['atk', 'hp', 'def'].includes(k) ? 1 : 0.01);
  console.log(`  ${k.padEnd(12)} ${got.toFixed(2).padStart(12)}  site ${String(want).padStart(9)}  ${ok ? 'ok' : 'MISMATCH'}`);
  if (!ok) fail(`stat ${k}`);
}

console.log('\nABILITY CHECK — engine rounded vs the integer arabwuwa prints');
let exact = 0;
for (const [label, want] of Object.entries(ABILITIES)) {
  const entry = abilityMap.get(label);
  if (!entry) { fail(`missing ability "${label}"`); continue; }
  const d = eng.abilityDamage(state, entry, enemy);
  if (!d) { fail(`could not evaluate "${label}"`); continue; }
  const got = Math.round(d.noncrit);
  const ok = got === want;
  if (ok) exact++; else fail(`${label}: ${got} vs ${want} (${((got - want) / want * 100).toFixed(2)}%)`);
  console.log(`  ${label.slice(0, 44).padEnd(44)} ${String(got).padStart(8)}  ${String(want).padStart(8)}  ${ok ? 'EXACT' : 'OFF'}`);
}
console.log(`\n  ${exact}/${Object.keys(ABILITIES).length} exact to the integer`);

console.log('\nFUSION BURST ISOLATION — bare Aemeath, no ATK involved');
const bare = JSON.parse(JSON.stringify(chars));
Object.assign(bare.characters.aemeath, { echoes: [], weapon: null, buffs: [], forteNodes: false });
delete bare.characters.aemeath.baseScale;
const eng2 = loadEngine(bare);
const map2 = eng2.abilities('aemeath');
for (const [name, mvPct, want] of STATUS_STEPS) {
  const st = eng2.buildState('aemeath', mvPct
    ? [{ id: 'x', target: 'self', kind: 'status', status: 'fusionBurst', bucket: 'mvPct', value: mvPct }]
    : []);
  const got = Math.round(eng2.abilityDamage(st, map2.get('Fusion Burst Hit (10 stacks)'), enemy).noncrit);
  const ok = got === want;
  if (!ok) fail(`status step "${name}"`);
  console.log(`  ${name.padEnd(38)} mvPct=${String(mvPct).padStart(4)}  ${String(got).padStart(7)}  ${String(want).padStart(7)}  ${ok ? 'EXACT' : 'OFF'}`);
}

console.log('\nPANEL CHECK — your live build vs the in-game character panel');
const live = loadEngine(chars);
for (const cid of Object.keys(chars.characters)) {
  const pc = live.panelCheck(cid);
  if (!pc) { console.log(`  ${cid.padEnd(10)} no panel recorded`); continue; }
  if (!pc.accountAccurate) {
    console.log(`  ${cid.padEnd(10)} unreconciled (weapon level / ascension not solved) — informational only`);
    continue;
  }
  for (const r of pc.rows) {
    console.log(`  ${cid.padEnd(10)} ${r.stat.padEnd(12)} ${r.computed.toFixed(2).padStart(10)}  panel ${String(r.panel).padStart(8)}  ${r.ok ? 'ok' : 'MISMATCH'}`);
    if (!r.ok) fail(`${cid} panel ${r.stat}`);
  }
}

console.log('\nROTATIONS');
for (const r of live.rotations.rotations) {
  const res = live.runRotation(r.id);
  console.log(`  ${r.id.padEnd(32)} ${Math.round(res.total).toLocaleString('en-US').padStart(12)}  (${res.steps.length} steps)`);
  for (const w of res.warnings) { fail(`rotation ${r.id}: ${w}`); }
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
