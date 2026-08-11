# Kelo Verification Bot

Bot officiel destiné à annoncer automatiquement les certifications émises par les certificateurs de confiance de Kelo Social.

Le bot surveille les records AT Protocol `app.bsky.graph.verification` des comptes configurés dans `TRUSTED_VERIFIERS`, puis publie une annonce avec le compte défini par `BOT_IDENTIFIER`.

## Variables d'environnement

| Variable | Description |
|---|---|
| `BOT_IDENTIFIER` | Handle du compte bot |
| `BOT_PASSWORD` | Mot de passe d'application du compte bot |
| `BOT_SERVICE` | URL du PDS du compte bot, par exemple `https://pds.kelosocial.eu` |
| `TRUSTED_VERIFIERS` | Handles ou DIDs des certificateurs de confiance, séparés par des virgules |
| `PUBLIC_APPVIEW` | AppView utilisé pour résoudre les handles et profils |
| `POLL_INTERVAL_MS` | Intervalle entre deux scans, 60000 par défaut |
| `STARTUP_GRACE_MS` | Fenêtre reprise après redémarrage, 300000 par défaut |

Ne jamais mettre le vrai mot de passe dans GitHub. Utiliser les variables secrètes de Render.

## Déploiement Render

Le dépôt contient un `render.yaml` prêt à l'emploi.

Dans Render :

1. Créer un Blueprint ou Web Service à partir de ce dépôt.
2. Utiliser la branche `main`.
3. Ajouter `BOT_IDENTIFIER`, `BOT_PASSWORD` et `TRUSTED_VERIFIERS` dans les variables d'environnement.
4. Vérifier `BOT_SERVICE` si le compte bot n'est pas hébergé sur `https://pds.kelosocial.eu`.
5. Déployer.

L'URL `/health` retourne l'état du bot. L'URL `/` affiche également les certificateurs actuellement résolus.

## Exemple de publication

```text
✅ Nouvelle certification Kelo Social

Entreprise Exemple (@exemple.eu) vient d’être certifié par Certificateur Exemple (@certificateur.eu).

Certification délivrée par un certificateur de confiance.
```

## Fonctionnement

- résolution du handle du certificateur en DID ;
- découverte automatique du PDS depuis le document DID ;
- lecture de `app.bsky.graph.verification` directement dans le dépôt AT Protocol du certificateur ;
- filtrage des anciens records au démarrage ;
- publication automatique avec le compte du bot ;
- déduplication en mémoire pendant l'exécution.

Pour une disponibilité réellement continue, utiliser un hébergement qui ne met pas le service en veille. Un Web Service Render gratuit peut s'endormir lorsqu'il ne reçoit pas de trafic entrant.
