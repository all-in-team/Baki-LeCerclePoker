#!/usr/bin/env bash
#
# Test du endpoint /go — 22 clics simulés couvrant les trois flags.
#
#   BASE_URL=http://localhost:3000 DEST_URL='https://t.me/+XXXX' ./test-go.sh
#
# IMPORTANT — où lancer ce script :
#
#   • En LOCAL (pas de reverse proxy devant l'app) : le X-Forwarded-For injecté
#     ci-dessous est bien l'IP vue par le endpoint. Les flags duplicate /
#     suspect_ip / no_ua sont vérifiables.
#
#   • En PROD (Railway) : le proxy ajoute sa propre entrée à X-Forwarded-For et
#     ton IP réelle écrase celle qu'on injecte ici. Les 22 clics partiront donc
#     de la même IP et suspect_ip tombera sur tout le bloc D et au-delà.
#     En prod, ne valide que le 302, la Location et la latence.
#
# Les compteurs de flags attendus sont affichés en fin de run, avec la requête
# SQL pour les confronter à ce qui a réellement été loggé.

set -uo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
DEST_URL="${DEST_URL:-}"

if [[ -z "$DEST_URL" ]]; then
  echo "DEST_URL manquant. Ex: DEST_URL='https://t.me/+Z8AqKZ57g2c3NWZh' $0" >&2
  exit 2
fi

# UA mobile réaliste : sans ça, curl s'annonce « curl/8.x » et déclenche no_ua
# sur la totalité des requêtes, ce qui rend le test inexploitable.
UA_MOBILE='Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'

pass=0; fail=0; slow=0

# hit <label> <ip> <ua> <query-string>
hit() {
  local label="$1" ip="$2" ua="$3" qs="$4"
  local ua_args=()
  if [[ "$ua" == "EMPTY" ]]; then
    ua_args=(-H 'User-Agent;')          # en-tête présent mais vide
  else
    ua_args=(-A "$ua")
  fi

  local out code loc t
  out=$(curl -s -o /dev/null -w '%{http_code}|%{redirect_url}|%{time_total}' \
        --max-time 10 \
        -H "X-Forwarded-For: $ip" \
        "${ua_args[@]}" \
        "${BASE_URL}/go?${qs}")

  code="${out%%|*}"; out="${out#*|}"
  loc="${out%%|*}"; t="${out##*|}"

  local ok=1
  [[ "$code" == "302" ]] || ok=0
  [[ "$loc" == "$DEST_URL" ]] || ok=0

  if (( ok )); then
    pass=$((pass+1)); printf '  ok   %-22s %ss\n' "$label" "$t"
  else
    fail=$((fail+1)); printf '  FAIL %-22s code=%s loc=%s\n' "$label" "$code" "$loc"
  fi

  # objectif < 100 ms : le logging ne doit jamais être sur le trajet du 302
  if awk "BEGIN{exit !($t > 0.1)}"; then
    slow=$((slow+1)); printf '       ↳ lent : %ss (> 100 ms)\n' "$t"
  fi
}

# Ids de créa tels que RichAds les transmet via [CREATIVE_ID] : numériques, pas
# nos slugs. Remplace-les par tes ids réels après création des créas — le test
# ne dépend d'aucune liste blanche, n'importe quel id bien formé passe.
CRE_1='48211'   # instant
CRE_2='48212'   # usdt
CRE_3='48213'   # antitriche

# Tag de run : rend les click_id uniques d'une exécution à l'autre. Sans lui, un
# second run rejoue les mêmes click_id et TOUTES les lignes tombent en `duplicate` —
# le flag ne prouve alors plus rien, puisqu'il ne discrimine plus. Avec le tag,
# seuls C1/C2 rejouent le A1 DU MÊME RUN, ce qui est le vrai test.
# `cid` reste CAMP42 en dur pour qu'une purge unique attrape tous les runs.
RUN_TAG="${RUN_TAG:-r1}"

# Dimensions communes. utm_content double cb : exigé par RichAds pour leur
# comptage, ignoré par le endpoint — sa présence ne doit rien casser.
# geo porte un NOM de pays, pas un code ISO (espaces encodés en %20).
q() { # q <cre> <sid> <app> <geo> <cost> <pu> <cb>
  printf 'cre=%s&cid=CAMP42&sid=%s&app=%s&geo=%s&cost=%s&pu=%s&cb=%s&utm_content=%s' \
    "$1" "$2" "$3" "$4" "$5" "$6" "$7" "$7"
}

echo
echo "== A · 4 clics normaux (IP et click_id distincts) ============================"
hit "A1 cre=$CRE_1" "203.0.113.11" "$UA_MOBILE" "$(q "$CRE_1" PUB_991 APP_77 Malaysia         0.021 premium CB-$RUN_TAG-A1)"
hit "A2 cre=$CRE_2" "203.0.113.12" "$UA_MOBILE" "$(q "$CRE_2" PUB_992 APP_78 Brazil           0.019 regular CB-$RUN_TAG-A2)"
hit "A3 cre=$CRE_3" "203.0.113.13" "$UA_MOBILE" "$(q "$CRE_3" PUB_993 APP_77 United%20Kingdom 0.015 premium CB-$RUN_TAG-A3)"
hit "A4 cre=99999"  "203.0.113.14" "$UA_MOBILE" "$(q 99999    PUB_994 APP_79 Indonesia        0.022 regular CB-$RUN_TAG-A4)"

echo
echo "== B · 3 cas limites (cre absent, macro non substituée, UA vide) ============="
hit "B1 cre absent"  "203.0.113.21" "$UA_MOBILE" "cid=CAMP42&sid=PUB_995&app=APP_77&geo=Turkey&cost=0.020&pu=regular&cb=CB-$RUN_TAG-B1&utm_content=CB-$RUN_TAG-B1"
hit "B2 macro brute" "203.0.113.22" "$UA_MOBILE" "$(q %5BCREATIVE_ID%5D PUB_996 APP_77 Turkey 0.020 regular CB-$RUN_TAG-B2)"
hit "B3 UA vide"     "203.0.113.23" "EMPTY"      "$(q "$CRE_1" PUB_997 APP_77 Turkey 0.020 regular CB-$RUN_TAG-B3)"

echo
echo "== C · 2 doublons (click_id de A1 rejoué) ===================================="
hit "C1 dup de A1" "203.0.113.31" "$UA_MOBILE" "$(q "$CRE_1" PUB_991 APP_77 Malaysia 0.021 premium CB-$RUN_TAG-A1)"
hit "C2 dup de A1" "203.0.113.32" "$UA_MOBILE" "$(q "$CRE_1" PUB_991 APP_77 Malaysia 0.021 premium CB-$RUN_TAG-A1)"

echo
echo "== D · rafale de 13 depuis 198.51.100.77 ===================================="
echo "   seuil à 10 clics déjà loggés → D11, D12 et D13 doivent être flagués"
for i in $(seq 1 13); do
  hit "D$i burst" "198.51.100.77" "$UA_MOBILE" "$(q "$CRE_2" PUB_998 APP_80 Indonesia 0.018 regular "CB-$RUN_TAG-D$i")"
done

echo
echo "=============================================================================="
printf 'redirect + Location : %d ok, %d en échec\n' "$pass" "$fail"
printf 'latence > 100 ms    : %d requête(s)\n' "$slow"

cat <<'EOF'

Attendu en base après un run sur base vierge — 22 lignes au total :

  cre="unknown"        2   (B1 absent, B2 macro non substituée)
  cre="99999"          1   (A4 : id hors table de correspondance, accepté tel quel)
  flag no_ua           1   (B3)
  flag duplicate       2   (C1, C2)
  flag suspect_ip      3   (D11, D12, D13)
  clics uniques       16   (22 − 6 lignes portant au moins un flag)

Trois contrôles de non-régression à faire à l'œil sur les lignes loggées :

  A4  cre="99999" — id absent de CRE_LABELS, doit être loggé tel quel et
      compté dans les uniques. S'il ressort "unknown", une liste blanche a
      été réintroduite quelque part.

  A3  geo="United Kingdom" — en toutes lettres, casse d'origine, non tronqué.
      "UNITED K" ou "United" = la troncature à 8 + majuscules est revenue.

  A1  app="APP_77" et pu="premium" renseignés. Colonnes vides = les nouveaux
      paramètres ne sont pas lus par le endpoint.

utm_content est présent sur les 22 requêtes et ne doit apparaître nulle part
en base : c'est le doublon de cb réclamé par RichAds, pas une dimension.

Aucune ligne ne doit manquer : un clic flagué est facturé par RichAds, il doit
apparaître dans les stats, marqué — jamais être écarté à l'insertion.

Requête de vérification :

  sqlite3 data/lecercle.db "
    SELECT cre, source,
           COUNT(*)                  AS bruts,
           SUM(is_unique)            AS uniques,
           SUM(flags LIKE '%duplicate%')  AS dup,
           SUM(flags LIKE '%suspect_ip%') AS susp,
           SUM(flags LIKE '%no_ua%')      AS no_ua,
           ROUND(SUM(cost), 4)       AS cout
    FROM   richads_clicks
    GROUP  BY cre ORDER BY bruts DESC;"

Et le contrôle des nouvelles dimensions :

  sqlite3 data/lecercle.db "
    SELECT geo, app, user_type, COUNT(*) FROM richads_clicks GROUP BY geo, app, user_type;"

Pour rejouer sans purger, changer de tag : RUN_TAG=r2 ./scripts/test-richads-go.sh
Les click_id sont alors neufs et `duplicate` retrouve son pouvoir discriminant.
Sans changer de tag, tout retombe en duplicate — comportement correct, mais le
test ne prouve plus rien.

En PROD, suspect_ip tombera sur la quasi-totalité des lignes : le proxy Railway
écrase le X-Forwarded-For injecté, les 22 clics viennent donc d'une seule IP
réelle. C'est la preuve que la détection de rafale fonctionne, pas un bug.
EOF

exit $(( fail > 0 ? 1 : 0 ))
