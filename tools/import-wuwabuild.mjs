/*
 * Pull character builds straight out of wuwa.build and turn them into the `stats`
 * blocks data/characters.json already uses.
 *
 *   node tools/import-wuwabuild.mjs <uid> [--write]
 *
 * WuWaBuilds (https://wuwa.build) runs a screenshot OCR importer that works on any OS —
 * it takes an in-game build-card screenshot, reads it server-side, and files the result
 * under your UID. Their read API is public and unauthenticated:
 *
 *   GET https://api.wuwa.build/profile/<uid>          summary
 *   GET https://api.wuwa.build/profile/<uid>/builds   every build, full stat totals
 *   GET https://api.wuwa.build/leaderboard/<charId>   1,991 real builds per character
 *   POST https://ocr.wuwa.build/api/ocr               the OCR endpoint itself
 *
 * The stat fields they return are a 1:1 match for our panel-stat block, which is the
 * whole reason this is worth automating: no substat detail is needed, because the engine
 * consumes panel totals as its primary input.
 */
const UID = process.argv[2];
const WRITE = process.argv.includes('--write');
if (!UID) { console.error('usage: node tools/import-wuwabuild.mjs <uid> [--write]'); process.exit(1); }

// their character ids are Kuro's roleGbId, the same ones our ref/ data uses
const CHARS = { '1210':'aemeath', '1110':'suisui', '1306':'augusta', '1503':'verina',
                '1103':'baizhi', '1204':'mortefi', '1211':'denia', '1108':'hiyuki',
                '1209':'mornye', '1509':'lynae' };
const MAP = {
  statATK:'atk', statHP:'hp', statDEF:'def', statCritRate:'critRate', statCritDmg:'critDmg',
  statEnergyRegen:'energyRegen', statBasicAttackDmg:'basicDmg', statHeavyAttackDmg:'heavyDmg',
  statResonanceSkillDmg:'skillDmg', statResonanceLiberationDmg:'libDmg', statHealingBonus:'healingBonus',
};
const ELEM = ['Aero','Glacio','Fusion','Electro','Havoc','Spectro'];

const get = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(`${r.status} ${u}`); return r.json(); };
const prof = await get(`https://api.wuwa.build/profile/${UID}`);
console.log(`profile ${UID}  ${prof.username || '(no name)'}  builds: ${prof.buildCount}  updated ${prof.updatedAt}`);
if (!prof.buildCount) {
  console.log('\nNo builds on this UID yet. Upload them at https://wuwa.build/import —');
  console.log('one in-game build-card screenshot per character, OCR runs server-side.');
  process.exit(0);
}
const { builds } = await get(`https://api.wuwa.build/profile/${UID}/builds?pageSize=60`);
const out = {};
for (const b of builds) {
  const id = CHARS[b.character?.id];
  if (!id) { console.log(`  skipped character id ${b.character?.id} — not on our roster`); continue; }
  const s = {};
  for (const [from, to] of Object.entries(MAP)) if (b[from] != null) s[to] = b[from];
  for (const e of ELEM) if (b['stat' + e + 'Dmg']) s.elemDmg = b['stat' + e + 'Dmg'];
  s.elemDmg ??= 0;
  s._note = `Imported from wuwa.build ${new Date().toISOString().slice(0,10)} (build ${b.id}). `
    + `Their OCR reads the in-game panel, so these are panel totals — exactly what the engine wants. `
    + `atkBase/hpBase/defBase still have to come from the level+weapon solve; they are not in this payload.`;
  out[id] = { stats: s, sequence: b.sequence, weapon: { id: b.weapon?.id, level: b.weapon?.level, rank: b.weapon?.rank },
              echoMains: (b.echoSummary?.mainStats || []).map(m => `c${m.cost}:${m.statType}`),
              sets: b.echoSummary?.sets };
  console.log(`  ${id.padEnd(9)} S${b.sequence}  ATK ${String(s.atk).padStart(5)}  CR ${String(s.critRate).padStart(5)}%  `
    + `CD ${String(s.critDmg).padStart(5)}%  elem ${String(s.elemDmg).padStart(3)}%  lib ${String(s.libDmg).padStart(5)}%`);
}
if (WRITE) {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const P = new URL('../data/characters.json', import.meta.url).pathname;
  const j = JSON.parse(readFileSync(P, 'utf8'));
  let n = 0;
  for (const [id, v] of Object.entries(out)) {
    if (!j.characters[id]) continue;
    const base = j.characters[id].stats || {};
    j.characters[id].stats = { ...base, ...v.stats };   // keeps atkBase/hpBase/defBase
    j.characters[id].panel = { ...v.stats }; delete j.characters[id].panel._note;
    n++;
  }
  writeFileSync(P, JSON.stringify(j, null, 2) + '\n');
  console.log(`\nwrote ${n} character(s) into data/characters.json — run tools/validate.mjs next`);
} else {
  console.log('\n(dry run — pass --write to merge into data/characters.json)');
}
