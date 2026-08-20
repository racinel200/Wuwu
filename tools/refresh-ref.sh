#!/usr/bin/env bash
# Re-pull arabwuwa's public reference data and trim it for the browser.
# All endpoints are public; no auth. Run from the repo root:  bash tools/refresh-ref.sh
set -euo pipefail
cd "$(dirname "$0")/.."
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

# Every character the calculator can reach. arabwuwa 404s on ones it has not built yet
# (2026-08-20: jingran, hsin, suoming), so a FAIL line here is information, not breakage.
CHARS="aemeath augusta baizhi brant calcharo camellya cantarella carlotta cartethyia changli chisa ciaccona denia encore galbrena hiyuki iuno jianxin jinhsi jiyan lingyang lucilla lucy lupa luukherssen lynae mornye mortefi phoebe phrolova qingxiao qiuyuan rebecca roccia rover-aero rover-electro rover-havoc rover-spectro shorekeeper sigrika suisui verina xiangli-yao xuanling yinlin zani zhezhi"
for c in $CHARS; do
  curl -sf "https://arabwuwa.com/api/calculator-character-data.php?action=projection&id=$c" \
    -o "$TMP/proj-$c.json" || { echo "  FAIL $c (no calculator data yet)"; continue; }
done
curl -sf "https://arabwuwa.com/data/weapons.json"     -o "$TMP/weapons.json"
curl -sf "https://arabwuwa.com/data/sonata-sets.json" -o "$TMP/sonata-sets.json"

python3 - "$TMP" "$CHARS" <<'PY'
import json, sys, os
tmp, chars = sys.argv[1], sys.argv[2].split()
KEEP = ('label','scaling','abilityType','damageType','values')
for cid in chars:
    c = json.load(open(f'{tmp}/proj-{cid}.json'))['data']['character']
    json.dump(dict(
        name=c['name'], element=c['element'], stats=c['stats'],
        forteSkills=c.get('forteSkills', []),
        multipliers={g: [{k: v for k, v in e.items() if k in KEEP} for e in ents]
                     for g, ents in c['multipliers'].items()},
        sequences=[{'node': s.get('node'), 'title': s.get('title')}
                   for s in c.get('sequences', []) if isinstance(s, dict)],
    ), open(f'ref/proj-{cid}.json', 'w'), separators=(',', ':'))

w = json.load(open(f'{tmp}/weapons.json'))
json.dump([{k: v for k, v in x.items()
            if k in ('id','name','rarity','type','stats','passiveBuffs')} for x in w],
          open('ref/weapons.json', 'w'), separators=(',', ':'))

s = json.load(open(f'{tmp}/sonata-sets.json'))
sets = s['sets'] if isinstance(s, dict) else s
json.dump([{k: v for k, v in x.items() if k in ('id','name','effects','calculatorBuffs')}
           for x in sets], open('ref/sonata-sets.json', 'w'), separators=(',', ':'))
print('ref/ refreshed')
PY

echo
echo "NOTE: ref/status-level-table.json is NOT refreshed here. It is the negative-status"
echo "level coefficient table, extracted from the compiled runtime:"
echo "  curl -s 'https://arabwuwa.com/api/calculator-runtime.php?artifact=route-calculator'"
echo "then pull the 100-entry array assigned to Ja=Object.freeze([...]) and read via Tr()."
echo
echo "Now run:  node tools/validate.mjs"
