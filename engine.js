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

/**
 * Split an MV expression into its individual damage instances.
 * '13.10%*4+26.20%*3+130.96%' -> eight numbers, not one.
 *
 * This matters for variance: WuWa rolls crit independently per damage instance, so an
 * ability that lands eight hits is far steadier than one that lands a single hit of the
 * same total size. Summing first and rolling once would badly overstate the spread.
 */
export function parseMVInstances(expr) {
  if (typeof expr !== 'string' || !expr.includes('%')) return null;
  const out = [];
  for (const m of expr.matchAll(MV_TOKEN)) {
    const v = parseFloat(m[1]) / 100;
    const n = m[2] ? parseInt(m[2], 10) : 1;
    for (let i = 0; i < n; i++) out.push(v);
  }
  return out;
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

  /**
   * Fetch the two editable documents from Supabase, or null if that is not usable.
   * Never throws: a Supabase problem must degrade to the committed files, never to a
   * broken page. Returns { characters, rotations, source }.
   */
  static async fromSupabase(cfg) {
    if (!cfg || cfg.enabled === false || !cfg.url || !cfg.key) return null;
    try {
      const url = `${cfg.url}/rest/v1/${cfg.table || 'docs'}?select=key,doc,updated_at`;
      const headers = { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` };
      if (cfg.schema && cfg.schema !== 'public') headers['Accept-Profile'] = cfg.schema;
      const r = await fetch(url, { headers, cache: 'no-store' });
      if (!r.ok) return null;
      const rows = await r.json();
      if (!Array.isArray(rows)) return null;
      const byKey = Object.fromEntries(rows.map(x => [x.key, x]));
      if (!byKey.characters?.doc || !byKey.rotations?.doc) return null;
      return {
        characters: byKey.characters.doc,
        rotations: byKey.rotations.doc,
        updatedAt: byKey.characters.updated_at,
      };
    } catch { return null; }
  }

  static async load(refDir = './ref', dataDir = './data') {
    const get = async (p) => {
      const r = await fetch(p, { cache: 'no-store' });
      if (!r.ok) throw new Error(`could not load ${p} (HTTP ${r.status})`);
      return r.json();
    };

    let source = 'repo files';
    let characters = null, rotations = null, updatedAt = null;
    let cfg = null;
    try { cfg = (await get(`${dataDir}/source.json`)).supabase; } catch { cfg = null; }
    const remote = await Engine.fromSupabase(cfg);
    if (remote) {
      characters = remote.characters; rotations = remote.rotations;
      updatedAt = remote.updatedAt; source = 'Supabase';
    }

    if (!characters) characters = await get(`${dataDir}/characters.json`);
    const ids = Object.keys(characters.characters);
    const projections = {};
    await Promise.all(ids.map(async id => { projections[id] = await get(`${refDir}/proj-${id}.json`); }));
    const ref = {
      projections,
      weapons: await get(`${refDir}/weapons.json`),
      sonata: await get(`${refDir}/sonata-sets.json`),
      statusLevels: await get(`${refDir}/status-level-table.json`),
    };
    if (!rotations) rotations = await get(`${dataDir}/rotations.json`);
    const eng = new Engine(ref, characters, rotations);
    eng.source = source;
    eng.sourceUpdatedAt = updatedAt;
    return eng;
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
  buildState(charId, activeBuffs = [], { forceRebuild = false } = {}) {
    const c = this.characters.characters[charId];
    if (!c) throw new Error(`character "${charId}" is not in characters.json`);
    const proj = this.projection(charId);

    // ---- PANEL MODE -------------------------------------------------------
    // If the character carries a `stats` block, those numbers are read straight off
    // the in-game stats page and used as-is. No level-derived base stats, no weapon
    // level curve, no ascension scale, no echo arithmetic, no forte-node guessing —
    // the game already did all of that. Buffs marked panel:true are skipped here,
    // because the panel reading already contains them.
    if (c.stats && !forceRebuild) {
      return this._stateFromStats(charId, c, proj, activeBuffs.filter(b => b.panel !== true));
    }

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

    // Forte stat nodes. `forteNodes` is either a boolean (all eight / none) or an object
    // keyed by statKey, because the ATK nodes and the Crit Rate nodes sit on different
    // branches of the Forte Circuit and are unlocked independently:
    //   "forteNodes": { "atkPct": true, "critRate": false }
    const fn = c.forteNodes;
    if (fn) {
      for (const n of (proj.forteSkills || [])) {
        const on = typeof fn === 'object' ? fn[n.statKey] === true : fn === true;
        if (on) add(n.statKey, parseFloat(n.value));
      }
    }

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
    const buckets = this._applyBuffs(activeBuffs, add, charId);
    const { amplify, defIgnore, resShred, mvPct, abilityCritDmg, vulnerability, status, tuneBreak,
            retype } = buckets;

    const hp = baseHP * (1 + (S.hpPct || 0) / 100) + (S.hp || 0);
    const atk = (baseATK + weaponATK) * (1 + (S.atkPct || 0) / 100) + (S.flatAtk || 0);
    const def = baseDEF * (1 + (S.defPct || 0) / 100) + (S.def || 0);

    return {
      charId, element: proj.element, level: c.level, talents: c.talents,
      stats: S, hp, atk, def, baseHP, baseATK, baseDEF, weaponATK, tuneBreakPoints,
      amplify, defIgnore, resShred, mvPct, abilityCritDmg, vulnerability, status, tuneBreak, retype,
    };
  }

  /**
   * Build a state directly from the in-game stats page.
   *
   * The one subtlety: an ATK% buff in WuWa multiplies the WHITE base number
   * (character base + weapon base), not the green total. So `atkBase` is required
   * alongside `atk` — both are shown on the same screen. Same for HP and DEF.
   */
  _stateFromStats(charId, c, proj, activeBuffs) {
    const st = c.stats;
    for (const k of ['atk', 'atkBase']) {
      if (st[k] == null) throw new Error(`${charId}: stats.${k} is required (read it off the in-game stats page)`);
    }
    const S = {};
    const add = (k, v) => { S[k] = (S[k] || 0) + v; };
    add('critRate', st.critRate ?? 5);
    add('critDmg', st.critDmg ?? 150);
    add('energyRegen', st.energyRegen ?? 100);
    for (const k of ['basicDmg', 'heavyDmg', 'skillDmg', 'libDmg', 'introDmg',
                     'outroDmg', 'echoDmg', 'healingBonus']) {
      if (st[k] != null) add(k, st[k]);
    }
    // the game folds All-Attribute DMG into the element line, which is exactly how the
    // damage formula consumes it — one additive bucket. Keep it there.
    if (st.elemDmg != null) add(`elemDmg:${proj.element}`, st.elemDmg);

    const buckets = this._applyBuffs(activeBuffs, add, charId);

    // percentage stat buffs scale the base, flat ones add to the total
    const hpBase = st.hpBase ?? 0, defBase = st.defBase ?? 0;
    const hp = (st.hp ?? 0) + hpBase * ((S.hpPct || 0) / 100) + (S.hp || 0);
    const atk = st.atk + st.atkBase * ((S.atkPct || 0) / 100) + (S.flatAtk || 0);
    const def = (st.def ?? 0) + defBase * ((S.defPct || 0) / 100) + (S.def || 0);

    return {
      charId, element: proj.element, level: c.level, talents: c.talents,
      stats: S, hp, atk, def, source: 'panel',
      baseATK: st.atkBase, baseHP: hpBase, baseDEF: defBase,
      tuneBreakPoints: c.tuneBreakPoints ?? parseFloat(proj.stats[LEVEL_TIERS.indexOf(c.level)][8]),
      ...buckets,
    };
  }

  /** Resolve a buff list into the non-stat damage buckets. Shared by both modes. */
  _applyBuffs(activeBuffs, add, charId) {
    const amplify = {}, defIgnore = {}, resShred = [], mvPct = {},
          abilityCritDmg = {}, vulnerability = {}, status = {}, tuneBreak = {}, retype = {};
    const bumpScoped = (map, buff, v) => {
      const keys = buff.abilities && buff.abilities.length ? buff.abilities : [buff.attackType || 'all'];
      for (const k of keys) map[k] = (map[k] || 0) + v;
    };
    for (const b of activeBuffs) {
      const v = Number(b.value) || 0;
      switch (b.kind) {
        case 'stat': add(b.stat, v); break;
        case 'amplify': bumpScoped(amplify, b, v); break;
        case 'vulnerability': bumpScoped(vulnerability, b, v); break;
        case 'defIgnore': defIgnore[b.attackType || 'all'] = (defIgnore[b.attackType || 'all'] || 0) + v; break;
        case 'resRed': resShred.push({ element: b.element || 'all', attackType: b.attackType || 'all', value: v }); break;
        case 'mvPct': for (const a of (b.abilities || [])) mvPct[a] = (mvPct[a] || 0) + v; break;
        // RETYPE. Some kits declare a skill "is considered Resonance Liberation DMG" although the
        // reference data types it as a Basic Attack. Not cosmetic: the attack type selects which
        // DMG-bonus stat applies and which type-scoped amplify / DEF-ignore / RES-shred match.
        case 'retype': for (const a of (b.abilities || [])) retype[a] = b.attackType; break;
        case 'abilityCritDmg': for (const a of (b.abilities || [])) abilityCritDmg[a] = (abilityCritDmg[a] || 0) + v; break;
        case 'status': {
          const st = (status[b.status] = status[b.status] || {});
          st[b.bucket] = (st[b.bucket] || 0) + v; break;
        }
        case 'tuneBreak': tuneBreak[b.bucket] = (tuneBreak[b.bucket] || 0) + v; break;
        default: this.warnings.push(`buff "${b.id}": unknown kind "${b.kind}"`);
      }
    }
    return { amplify, defIgnore, resShred, mvPct, abilityCritDmg, vulnerability, status, tuneBreak, retype };
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
    const state = this.buildState(charId, panelBuffs, { forceRebuild: true });
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
      // Tolerances are set by the GAME'S OWN DISPLAY PRECISION, not by how exact we would like
      // to be. The panel prints percentages to one decimal, so each contributing term carries up
      // to 0.05 of rounding and a stat built from several terms can legitimately land 0.1 away.
      // ATK/HP/DEF are printed as integers and rest on level-base rows that are themselves
      // rounded, so they need a relative band. Anything looser stops catching real drift - the
      // Mortefi divergence that mattered on Aug 12 was 0.358%, well outside 0.25%.
      const tol = ['atk', 'hp', 'def'].includes(k) ? Math.max(2.0, want * 0.0025) : 0.15;
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
    const dt = (state.retype && state.retype[entry.label]) || dtypes[0] || 'basic';

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

  /**
   * Monte Carlo over a rotation, rolling crit independently for every damage instance.
   *
   * The deterministic total is the expected value and stays the number to compare builds
   * on. This answers the different question: how much does a single run actually swing?
   */
  simulateRotation(id, trials = 20000) {
    const det = this.runRotation(id);
    const rot = det.rotation;
    const enemy0 = det.enemy;

    // flatten the rotation into independent crit rolls
    const pool = [];   // { each, critMult, critRate }  one entry per damage instance
    let fixed = 0;     // damage that cannot crit at all
    for (const step of det.steps) {
      if (!step.counts) continue;
      if (step.raw != null) { fixed += step.average; continue; }
      const state = step._state || det.states[step.char];   // per-step, so buff windows apply
      if (!state) continue;
      const map = this.abilities(step.char);
      for (const label of (step.hits || [])) {
        const entry = map.get(label);
        if (!entry) continue;
        const d = this.abilityDamage(state, entry, enemy0);
        if (!d) continue;
        const scaling = entry.scaling || 'ATK';
        if (NEGATIVE_STATUS.includes(scaling) || scaling === 'tuneBreakSystem') {
          fixed += d.average; continue;             // fixed-damage paths never crit
        }
        const tl = entry.talentKey ? (state.talents[entry.talentKey] ?? 10) : 10;
        const rawMV = (entry.values || [])[Math.max(0, Math.min(9, tl - 1))] || '';
        const inst = parseMVInstances(rawMV) || [];
        const totalMV = inst.reduce((a, b) => a + b, 0);
        if (!totalMV) { fixed += d.average; continue; }
        const cd = ((state.stats.critDmg || 0) + (state.abilityCritDmg[entry.label] || 0)) / 100;
        const cr = Math.min(1, (state.stats.critRate || 0) / 100);
        for (const mv of inst) pool.push({ each: d.noncrit * (mv / totalMV), critMult: cd, critRate: cr });
      }
    }

    const totals = new Float64Array(trials);
    for (let t = 0; t < trials; t++) {
      let sum = fixed;
      for (const h of pool) sum += Math.random() < h.critRate ? h.each * h.critMult : h.each;
      totals[t] = sum;
    }
    totals.sort();
    const q = (p) => totals[Math.min(trials - 1, Math.floor(p * trials))];
    const mean = totals.reduce((a, b) => a + b, 0) / trials;
    const sd = Math.sqrt(totals.reduce((a, b) => a + (b - mean) ** 2, 0) / trials);

    return {
      expected: det.total, instances: pool.length, fixed, trials,
      mean, sd, cv: sd / mean,
      min: totals[0], max: totals[trials - 1],
      p10: q(0.10), p50: q(0.50), p90: q(0.90),
      // sanity: the simulated mean must converge on the analytic expected value
      meanDrift: Math.abs(mean - det.total) / det.total,
    };
  }

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

    // a rotation carries either a flat `steps` array or `groups[].steps[]`
    const flat = [];
    if (rot.groups) {
      rot.groups.forEach((g, gi) => (g.steps || []).forEach((st, si) =>
        flat.push({ ...st, _group: gi, _idx: si, _counts: g.count !== false })));
    } else {
      (rot.steps || []).forEach((st, si) => flat.push({ ...st, _group: 0, _idx: si, _counts: true }));
    }
    // Step numbers are 1-based and global — the same number printed on each icon tile — so a
    // buff window is written exactly the way you read it off the page.
    flat.forEach((s, i) => { s._n = i + 1; });
    const N = flat.length;

    // BUFF WINDOWS live on the ROTATION, not on the buff — step numbers are per-rotation, and the
    // same buff appears in rotations of different lengths. `rot.windows` maps a buff id to
    // [fromStep, untilStep], both inclusive, null on either end meaning "open".
    //   "windows": { "verina.outro.blossom": [13, null] }
    // A buff-level fromStep/untilStep is still honoured as a fallback for buffs that only ever
    // appear in one rotation, but the rotation entry wins and is the form to prefer.
    const rawSpan = (b) => {
      const w = (rot.windows || {})[b.id];
      if (Array.isArray(w)) return [w[0] ?? 1, w[1] ?? N];
      if (w && typeof w === 'object') return [w.from ?? 1, w.until ?? N];
      return [b.fromStep ?? 1, b.untilStep ?? N];
    };
    const spanOf = (b) => { const [f, u] = rawSpan(b); return [Math.max(1, f), Math.min(N, u)]; };
    // OUTRO SEMANTICS. A team buff reaches everyone, which is right for auras and wrong for Outro
    // grants, which reach only the INCOMING Resonator. `{ "from": 26, "only": "aemeath" }` withholds
    // it from everyone else even inside its window. Step windows alone cannot express this once an
    // off-field character (Denia's Erosion Field) has steps interleaved with the recipient's.
    const onlyFor = {};
    for (const [bid, w] of Object.entries(rot.windows || {}))
      if (w && !Array.isArray(w) && typeof w === 'object' && w.only) onlyFor[bid] = w.only;
    const reaches = (b, cid) => (!onlyFor[b.id] || onlyFor[b.id] === cid)
                             && (b.target === 'team' || b.owner === cid);
    for (const bid of Object.keys(rot.windows || {}))
      if (!chosen.some(b => b.id === bid))
        this.warnings.push(`rotation "${id}" has a window for "${bid}", which it does not list as a buff`);
    for (const b of chosen) {
      const [f, u] = rawSpan(b);
      if (f > u) this.warnings.push(`buff "${b.id}": fromStep ${f} is after untilStep ${u}`);
      if (f < 1 || u > N) this.warnings.push(
        `buff "${b.id}": window ${f}–${u} falls outside this rotation's steps 1–${N}`);
    }
    const windowed = chosen.some(b => { const [f, u] = rawSpan(b); return f !== 1 || u !== N; });
    const activeAt = (n) => chosen.filter(b => { const [f, u] = spanOf(b); return n >= f && n <= u; });

    const abilityMaps = {};
    for (const cid of (rot.team || [])) abilityMaps[cid] = this.abilities(cid);

    // One state per (character, set of buffs actually live at that step). Without windows this
    // collapses to one state per character, so the no-windows path costs nothing.
    const stateCache = new Map();
    const stateFor = (cid, n) => {
      const forThem = activeAt(n).filter(b => reaches(b, cid));
      const key = `${cid}|${forThem.map(b => b.id).join(',')}`;
      if (!stateCache.has(key)) stateCache.set(key, this.buildState(cid, forThem));
      return stateCache.get(key);
    };
    // states[] keeps its old meaning: every buff this rotation lists, ignoring windows.
    const states = {};
    for (const cid of (rot.team || [])) {
      states[cid] = this.buildState(cid, chosen.filter(b => reaches(b, cid)));
    }
    const buffWindows = chosen.map(b => {
      const [f, u] = spanOf(b);
      return { id: b.id, name: b.name || b.id, from: f, until: u, target: b.target || 'self',
               owner: b.owner, whole: f === 1 && u === N };
    });

    const steps = [];
    let total = 0;
    for (const step of flat) {
      // a step may inject a known fixed number (e.g. main-echo damage, which the
      // character projection data does not carry)
      // `hits` is the list of ability instances this step actually fires. Entries are a
      // label, or { ability, times }. A step with no hits is a switch / wait / buff press.
      const hits = [];
      for (const h of (step.hits || [])) {
        const label = typeof h === 'string' ? h : h.ability;
        const times = typeof h === 'string' ? 1 : (h.times ?? 1);
        for (let i = 0; i < times; i++) hits.push(label);
      }

      let noncrit = 0, average = 0, crit = 0, ok = true, stepState = null;
      const breakdown = [];   // one row per ability instance, so the UI can show the split
      if (step.raw != null) {
        noncrit = average = crit = Number(step.raw);
        breakdown.push({ label: 'fixed amount', noncrit, average, crit, fixed: true });
      } else if (hits.length) {
        const cid = step.char;
        if (!states[cid]) {
          this.warnings.push(`step "${step.action || ''}" references "${cid}", who is not on this rotation's team`);
          ok = false;
        } else {
          stepState = stateFor(cid, step._n);
          for (const label of hits) {
            const entry = abilityMaps[cid].get(label);
            if (!entry) {
              this.warnings.push(`"${cid}" has no ability named "${label}" — check it against the ability list`);
              ok = false; continue;
            }
            const d = this.abilityDamage(stepState, entry, enemy);
            if (!d) { this.warnings.push(`could not evaluate "${label}"`); ok = false; continue; }
            noncrit += d.noncrit; average += d.average; crit += d.crit;
            const prev = breakdown.find(b => b.label === label);
            if (prev) { prev.times++; prev.noncrit += d.noncrit; prev.average += d.average; prev.crit += d.crit; }
            else breakdown.push({ label, times: 1, noncrit: d.noncrit, average: d.average, crit: d.crit,
                                  fixed: NEGATIVE_STATUS.includes(entry.scaling) || entry.scaling === 'tuneBreakSystem' });
          }
        }
      }
      if (step._counts && ok) total += average;
      steps.push({ ...step, hits, breakdown, noncrit, average, crit, counts: step._counts,
                   each: average, total: average, note: step.note || '',
                   n: step._n, _state: stepState,
                   liveBuffs: activeAt(step._n).filter(b => reaches(b, step.char)).map(b => b.id) });
    }

    const panels = {};
    for (const cid of Object.keys(states)) panels[cid] = this.panelCheck(cid);

    return { rotation: rot, steps, total, states, panels, enemy, stepCount: N,
             buffWindows, windowed, warnings: [...this.warnings] };
  }
}

export default Engine;
