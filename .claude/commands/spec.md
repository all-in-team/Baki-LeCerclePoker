Tu reçois un brain-dump brut : $ARGUMENTS.

1) Explore d'abord le code concerné.
2) Si le dump est trop vague, pose-moi 1-2 questions ciblées max, en exigeant un cas réel.
3) Restructure en spec : Cas réel → Cause probable → Fixes (règles dures) → Critères de test.
4) Montre-moi la spec et attends mon GO explicite, zéro code avant.
5) Après GO : implémente, commit, ouvre une PR vers main et merge-la toi-même (gh si dispo, sinon l'API GitHub avec GH_TOKEN), puis réponds uniquement : ✅ MERGED — Railway déploie, vérifie le CRM dans ~2 min.

EXCEPTION : si le diff touche l'authentification, les migrations/schéma de base de données, la logique d'accounting ou les settlements partenaires, ne merge PAS — donne-moi le lien de la PR avec une ligne expliquant le risque.
