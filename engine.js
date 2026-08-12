/*
 * WuWa damage engine.
 *
 * A faithful reimplementation of the arabwuwa calculator model, derived by reading
 * api/calculator-runtime.php?artifact=route-calculator and confirmed against the live
 * site on 29 of 29 abilities, exact to the displayed integer.
 *
 * There are THREE damage paths, dispatched on the ability's `scaling` field:
 *
 *   1. ATK / HP / DEF          ordinary abilities
 *   2. negative status         fusionBurst & friends — does NOT use ATK at all
 *   3. tuneBreakSystem         Tune Break / Tune Rupture responses
 *
 * See README.md for the formulas. Nothing here is fitted; it is transcribed.
 */

export const ELEMENTS = ['fusion', 'glacio', 'electro', 'aero', 'spectro', 'havoc'];

export const NEGATIVE_STATUS = ['aeroErosion', 'spectroFrazzle', 'electroFlare',
  'fusionBurst', 'havocBane', 'glacioChafe', 'glacioBite'];

const LEVEL_TIERS = [1, 10, 20, 30, 40, 50, 60, 70, 80, 90];

const TUNE_BREAK_LEVEL_MOD = 716.22;
const TUNE_BREAK_ENEMY_TYPE_MULT = 14;

// 5-star +25 echo main-stat values by cost
const MAIN_BY_COST = {
  4: { hpPct: 33.0, atkPct: 33.0, defPct: 41.5, critRate: 22.0, critDmg: 44.0, healingBonus: 26.4 },
  3: { hpPct: 30.0, atkPct: 30.0, defPct: 38.0, energyRegen: 32.0,
       ...Object.fromEntries(ELEMENTS.map(e => [`elemDmg:${e}`, 30.0])) },
  1: { hpPct: 22.8, atkPct: 18.0, defPct: 18.0 },
};
const SECONDARY_BY_COST = { 4: ['flatAtk', 150.0], 3: ['flatAtk', 100.0], 1: ['hp', 2280.0] };

const WEAPON_STAT_LABELS = {
  'ATK': 'flatAtk', 'Crit Rate': 'critRate', 'CRIT Rate': 'critRate',
  'Crit DMG': 'critDmg', 'CRIT DMG': 'critDmg', 'ATK%': 'atkPct',
  'HP%': 'hpPct', 'DEF%': 'defPct', 'Energy Regen': 'energyRegen',
  'Healing Bonus': 'healingBonus',
};

const ATTACK_TYPE_STAT = {
  basic: 'basicDmg', heavy: 'heavyDmg', skill: 'skillDmg', liberation: 'libDmg',
  intro: 'introDmg', outro: 'outroDmg', echo: 'echoDmg',
};

// ---------------------------------------------------------------- MV parsing

const MV_TOKEN = /([\d.]+)%(?:\s*\*\s*(\d+))?/g;

export function parseMV(expr) {
  if (typeof expr !== 'string' || !expr.includes('%')) return null;
  let total = 0;
  for (const m of expr.matchAll(MV_TOKEN)) {
    total += (parseFloat(m[1]) / 100) * (m[2] ? parseInt(m[2], 10) : 1);
  }
  return total;
}

export function parseTuneAmp(expr) {
  const m = /([\d.]+)%\s*Tune\s*AMP/i.exec(expr || '');
  return m ? parseFloat(m[1]) / 100 : null;
}

function resMult(resPct) {
  const n = resPct / 100;
  return Math.max(0, n >= 0 ? 1 - n : 1 - n / 2);
}

// ---------------------------------------------------------------- the engine

export class Engine {
  constructor(ref, characters, rotations) {
    this.ref = ref;
    this.characters = characters;
    this.rotations = rotations;
    this.warnings = [];
  }

  static async load(refDir = './ref', dataDir = './data') {
    const get = async (p) => {
      const r = await fetch(p, { cache: 'no-store' });
      if (!r.ok) throw new Error(`could not load ${p} (HTTP ${r.status})`);
      return r.json();
    };
    const characters = await get(`${dataDir}/characters.json`);
    const ids = Object.keys(characters.characters);
    const projections = {};
    await Promise.all(ids.map(async id => { projections[id] = await get(`${refDir}/proj-${id}.json`); }));
    const ref = {
      projections,
      weapons: await get(`${refDir}/weapons.json`),
      sonata: await get(`${refDir}/sonata-sets.json`),
      statusLevels: await get(`${refDir}/status-level-table.json`),
    };
    const rotations = await get(`${dataDir}/rotations.json`);
    return new Engine(ref, characters, rotations);
  }

  projection(id) {
    const p = this.ref.projections[id];
    if (!p) throw new Error(`no reference data for character "${id}" (expected ref/proj-${id}.json)`);
    return p;
  }

  weapon(id) {
    const w = this.ref.weapons.find(x => x.id === id);
    if (!w) throw new Error(`unknown weapon "${id}"`);
    return w;
  }

  statusLevelCoeff(level) {
    const t = Math.round(Math.max(1, Math.min(this.ref.statusLevels.length, level)));
    return this.ref.statusLevels[t - 1];
  }

  /** Every buff the data files define, flattened and indexed by id. */
  allBuffs() {
    if (this._buffIndex) return this._buffIndex;
    const idx = new Map();
    for (const [owner, c] of Object.entries(this.characters.characters)) {
      for (const b of (c.buffs || [])) {
        if (idx.has(b.id)) this.warnings.push(`duplicate buff id "${b.id}"`);
        idx.set(b.id, { ...b, owner });
      }
    }
    this._buffIndex = idx;
    return idx;
  }

  // ------------------------------------------------------------- stat block

  /**
   * Build one character's resolved state under a set of active buffs.
   * `activeBuffs` is an array of resolved buff objects (already filtered for target).
   */
  buildState(charId, activeBuffs = []) {
    const c = this.characters.characters[charId];
    if (!c) throw new Error(`character "${charId}" is not in characters.json`);
    const proj = this.projection(charId);

    const tier = LEVEL_TIERS.indexOf(c.level);
    if (tier < 0) throw new Error(`${charId}: level ${c.level} is not one of ${LEVEL_TIERS.join(', ')}`);
    const row = proj.stats[tier];

    const scale = c.baseScale ?? 1.0;
    const baseHP = parseFloat(row[0]) * scale;
    const baseATK = parseFloat(row[1]) * scale;
    const baseDEF = parseFloat(row[2]) * scale;
    const tuneBreakPoints = c.tuneBreakPoints ?? parseFloat(row[8]);

    const S = {};
    const add = (k, v) => { S[k] = (S[k] || 0) + v; };
    add('critRate', parseFloat(String(row[4]).replace('%', '')));
    add('critDmg', parseFloat(String(row[5]).replace('%', '')));
    add('energyRegen', 100);

    // weapon
    let weaponATK = 0;
    if (c.weapon && c.weapon.id) {
      if (c.weapon.atkOverride != null) {
        weaponATK = c.weapon.atkOverride;
        if (c.weapon.subOverride) add(c.weapon.subOverride.stat, c.weapon.subOverride.value);
      } else {
        const w = this.weapon(c.weapon.id);
        for (const [label, raw] of w.stats[String(c.weapon.rank || 1)]) {
          const v = parseFloat(String(raw).trim().replace('%', ''));
          if (label === 'ATK') weaponATK += v;
          else if (WEAPON_STAT_LABELS[label]) add(WEAPON_STAT_LABELS[label], v);
          else this.warnings.push(`${charId}: unmapped weapon stat "${label}"`);
        }
      }
    }

    // forte stat nodes
    if (c.forteNodes) for (const n of (proj.forteSkills || [])) add(n.statKey, parseFloat(n.value));

    // echoes
    for (const e of (c.echoes || [])) {
      const mainValue = e.mainValue ?? (MAIN_BY_COST[e.cost] || {})[e.main];
      if (mainValue == null) throw new Error(`${charId}: no main-stat value for cost ${e.cost} "${e.main}"`);
      add(e.main, mainValue);
      const sec = e.secondary ? [e.secondary.stat, e.secondary.value] : SECONDARY_BY_COST[e.cost];
      add(sec[0], sec[1]);
      for (const [k, v] of (e.subs || [])) add(k, v);
    }

    // buffs
    const amplify = {};       // key: 'all' | attackType | ability label -> percent
    const defIgnore = {};     // key: 'all' | attackType -> percent
    const resShred = [];      // {element, attackType, value}
    const mvPct = {};         // ability label -> percent
    const abilityCritDmg = {};// ability label -> percent
    const vulnerability = {}; // key: 'all' | attackType -> percent
    const status = {};        // status -> {mvPct, addMV, mvMult, amplify, dmgBonus, vulnerability, defRed, resRed}
    const tuneBreak = {};

    const bumpScoped = (map, buff, v) => {
      const keys = buff.abilities && buff.abilities.length
        ? buff.abilities
        : [buff.attackType || 'all'];
      for (const k of keys) map[k] = (map[k] || 0) + v;
    };

    for (const b of activeBuffs) {
      const v = Number(b.value) || 0;
      switch (b.kind) {
        case 'stat':
          add(b.stat, v);
          break;
        case 'amplify':
          bumpScoped(amplify, b, v);
          break;
        case 'vulnerability':
          bumpScoped(vulnerability, b, v);
          break;
        case 'defIgnore':
          defIgnore[b.attackType || 'all'] = (defIgnore[b.attackType || 'all'] || 0) + v;
          break;
        case 'resRed':
          resShred.push({ element: b.element || 'all', attackType: b.attackType || 'all', value: v });
          break;
        case 'mvPct':
          for (const a of (b.abilities || [])) mvPct[a] = (mvPct[a] || 0) + v;
          break;
        case 'abilityCritDmg':
          for (const a of (b.abilities || [])) abilityCritDmg[a] = (abilityCritDmg[a] || 0) + v;
          break;
        case 'status': {
          const st = b.status;
          status[st] = status[st] || {};
          status[st][b.bucket] = (status[st][b.bucket] || 0) + v;
          break;
        }
        case 'tuneBreak':
          tuneBreak[b.bucket] = (tuneBreak[b.bucket] || 0) + v;
          break;
        default:
          this.warnings.push(`buff "${b.id}": unknown kind "${b.kind}"`);
      }
    }

    const hp = baseHP * (1 + (S.hpPct || 0) / 100) + (S.hp || 0);
    const atk = (baseATK + weaponATK) * (1 + (S.atkPct || 0) / 100) + (S.flatAtk || 0);
    const def = baseDEF * (1 + (S.defPct || 0) / 100) + (S.def || 0);

    return {
      charId, element: proj.element, level: c.level, talents: c.talents,
      stats: S, hp, atk, def, baseHP, baseATK, baseDEF, weaponATK, tuneBreakPoints,
      amplify, defIgnore, resShred, mvPct, abilityCritDmg, vulnerability, status, tuneBreak,
    };
  }

  /**
   * Recompute a character's stats using ONLY the buffs marked panel:true — that is,
   * exactly what the in-game character panel shows — and compare against the recorded
   * panel readings. This is the guard that makes it safe for any chat to edit
   * characters.json blind: a fat-fingered substat turns a badge red.
   */
  panelCheck(charId) {
    const c = this.characters.characters[charId];
    if (!c || !c.panel) return null;
    const panelBuffs = (c.buffs || []).filter(b => b.panel === true).map(b => ({ ...b, owner: charId }));
    const state = this.buildState(charId, panelBuffs);
    const S = state.stats;
    const got = {
      atk: state.atk, hp: state.hp, def: state.def,
      critRate: S.critRate || 0, critDmg: S.critDmg || 0,
      energyRegen: S.energyRegen || 0,
      // the game folds All-Attribute DMG into the element line; the model keeps it separate
      elemDmg: (S[`elemDmg:${state.element}`] || 0) + (S.attrDmg || 0),
      basicDmg: S.basicDmg || 0, heavyDmg: S.heavyDmg || 0,
      skillDmg: S.skillDmg || 0, libDmg: S.libDmg || 0,
    };
    const rows = [];
    for (const [k, want] of Object.entries(c.panel)) {
      if (got[k] == null) continue;
      const tol = ['atk', 'hp', 'def'].includes(k) ? 1.0 : 0.06;
      rows.push({ stat: k, computed: got[k], panel: want, ok: Math.abs(got[k] - want) <= tol });
    }
    return { accountAccurate: c.accountAccurate === true, rows, allOk: rows.every(r => r.ok) };
  }

  // ---------------------------------------------------------------- damage

  /** All ability entries for a character, keyed by exact label. */
  abilities(charId) {
    const proj = this.projection(charId);
    const out = new Map();
    const groupTalent = { basic: 'basic', resSkill: 'skill', forte: 'forte',
      liberation: 'liberation', intro: 'intro', outro: 'intro' };
    for (const [group, entries] of Object.entries(proj.multipliers)) {
      for (const e of entries) {
        if (e.abilityType !== 'damage') continue;
        out.set(e.label, { ...e, group, talentKey: groupTalent[group] || null });
      }
    }
    return out;
  }

  /** Damage for one ability under a prepared state. Returns {noncrit, average, crit}. */
  abilityDamage(state, entry, enemy) {
    const enemyLevel = enemy.level;
    const enemyRes = enemy.res;
    const A = 800 + 8 * state.level;
    const D = 792 + 8 * enemyLevel;
    const tl = entry.talentKey ? (state.talents[entry.talentKey] ?? 10) : 10;
    const raw = (entry.values || [])[Math.max(0, Math.min(9, tl - 1))] || '';
    const scaling = entry.scaling || 'ATK';
    const dtypes = entry.damageType || [];
    const dt = dtypes[0] || 'basic';

    // ---- negative status: no ATK anywhere on this path
    if (NEGATIVE_STATUS.includes(scaling)) {
      const mv = parseMV(raw);
      if (mv == null) return null;
      const sc = state.status[scaling] || {};
      const mvEff = (mv + (sc.addMV || 0) / 100) * (1 + (sc.mvPct || 0) / 100) * (1 + (sc.mvMult || 0) / 100);
      const base = this.statusLevelCoeff(state.level) * mvEff;
      // arabwuwa forces defIgnore to 0 here, and refuses RES reduction for fusionBurst
      const shred = scaling === 'fusionBurst' ? 0 : (sc.resRed || 0);
      const defMult = A / (A + D * (1 - (sc.defRed || 0) / 100));
      const rm = resMult((enemyRes[state.element] ?? 0) - shred);
      const noncrit = base
        * (1 + (sc.amplify || 0) / 100)
        * (1 + (sc.dmgBonus || 0) / 100)
        * (1 + (sc.vulnerability || 0) / 100)
        * defMult * rm;
      return { noncrit, average: noncrit, crit: noncrit };
    }

    // ---- tune break system
    if (scaling === 'tuneBreakSystem') {
      const ampFrac = parseTuneAmp(raw);
      if (ampFrac == null) return null;
      const tb = state.tuneBreak;
      const mvEff = (ampFrac + (tb.addMV || 0) / 100)
        * (1 + (tb.mvPct || 0) / 100) * (1 + (tb.mvMult || 0) / 100);
      const base = TUNE_BREAK_LEVEL_MOD * TUNE_BREAK_ENEMY_TYPE_MULT
        * (1 + Math.max(0, Math.min(100, state.tuneBreakPoints)) / 100) * mvEff;
      const defMult = A / (A + D * (1 - (tb.defRed || 0) / 100) * (1 - (tb.defIgnore || 0) / 100));
      const rm = resMult((enemyRes[state.element] ?? 0) - (tb.resRed || 0));
      const noncrit = base * (1 + (tb.amplify || 0) / 100) * (1 + (tb.dmgBonus || 0) / 100)
        * (1 + (tb.vulnerability || 0) / 100) * defMult * rm;
      return { noncrit, average: noncrit, crit: noncrit };
    }

    // ---- ordinary ATK / HP / DEF scaling
    let mv = parseMV(raw);
    if (mv == null) return null;
    mv *= (1 + (state.mvPct[entry.label] || 0) / 100);

    const statValue = scaling === 'HP' ? state.hp : scaling === 'DEF' ? state.def : state.atk;
    const S = state.stats;

    let bonus = (S.attrDmg || 0) + (S[`elemDmg:${state.element}`] || 0);
    const typeStat = ATTACK_TYPE_STAT[dt];
    if (typeStat) bonus += (S[typeStat] || 0);

    const amp = (state.amplify.all || 0) + (state.amplify[dt] || 0) + (state.amplify[entry.label] || 0);
    const ign = ((state.defIgnore.all || 0) + (state.defIgnore[dt] || 0)) / 100;
    const shred = state.resShred
      .filter(r => (r.element === state.element || r.element === 'all')
                && (r.attackType === dt || r.attackType === 'all'))
      .reduce((a, r) => a + r.value, 0);
    const vuln = (state.vulnerability.all || 0) + (state.vulnerability[dt] || 0);

    const defMult = A / (A + D * (1 - ign));
    const rm = resMult((enemyRes[state.element] ?? 0) - shred);

    const noncrit = mv * statValue
      * (1 + bonus / 100) * (1 + amp / 100)
      * defMult * rm * (1 + vuln / 100);

    const cd = ((S.critDmg || 0) + (state.abilityCritDmg[entry.label] || 0)) / 100;
    const cr = Math.min(1, (S.critRate || 0) / 100);
    return { noncrit, average: noncrit * (1 + cr * (cd - 1)), crit: noncrit * cd };
  }

  // -------------------------------------------------------------- rotations

  rotation(id) {
    const r = (this.rotations.rotations || []).find(x => x.id === id);
    if (!r) throw new Error(`no rotation with id "${id}"`);
    return r;
  }

  /**
   * Score a rotation. Returns per-step damage and the single total.
   * `crit` defaults to "average"; a step may override with "noncrit" or "crit".
   */
  runRotation(id) {
    this.warnings = [];
    const rot = this.rotation(id);
    const enemy = {
      level: rot.enemy?.level ?? 100,
      res: typeof rot.enemy?.res === 'number'
        ? Object.fromEntries(ELEMENTS.map(e => [e, rot.enemy.res]))
        : (rot.enemy?.res || Object.fromEntries(ELEMENTS.map(e => [e, 20]))),
    };

    const index = this.allBuffs();
    const chosen = [];
    for (const bid of (rot.buffs || [])) {
      const b = index.get(bid);
      if (!b) { this.warnings.push(`rotation "${id}" lists unknown buff "${bid}"`); continue; }
      chosen.push(b);
    }

    // one state per character, with only the buffs that reach them
    const states = {};
    const abilityMaps = {};
    for (const cid of (rot.team || [])) {
      const forThem = chosen.filter(b => b.target === 'team' || b.owner === cid);
      states[cid] = this.buildState(cid, forThem);
      abilityMaps[cid] = this.abilities(cid);
    }

    const steps = [];
    let total = 0;
    for (const step of (rot.steps || [])) {
      // a step may inject a known fixed number (e.g. main-echo damage, which the
      // character projection data does not carry)
      if (step.raw != null) {
        const count = step.count ?? 1;
        const sub = Number(step.raw) * count;
        total += sub;
        steps.push({ ...step, count, each: Number(step.raw), total: sub, note: step.note || '' });
        continue;
      }
      const cid = step.char;
      if (!states[cid]) {
        this.warnings.push(`step references "${cid}", who is not in this rotation's team`);
        continue;
      }
      const entry = abilityMaps[cid].get(step.ability);
      if (!entry) {
        this.warnings.push(`"${cid}" has no ability named "${step.ability}" — check spelling against the ability list`);
        continue;
      }
      const d = this.abilityDamage(states[cid], entry, enemy);
      if (!d) { this.warnings.push(`could not evaluate "${step.ability}"`); continue; }
      const mode = step.crit || rot.critMode || 'average';
      const each = d[mode === 'noncrit' ? 'noncrit' : mode === 'crit' ? 'crit' : 'average'];
      const count = step.count ?? 1;
      const sub = each * count;
      total += sub;
      steps.push({ ...step, count, each, total: sub, note: step.note || '' });
    }

    const panels = {};
    for (const cid of Object.keys(states)) panels[cid] = this.panelCheck(cid);

    return { rotation: rot, steps, total, states, panels, enemy, warnings: [...this.warnings] };
  }
}

export default Engine;
