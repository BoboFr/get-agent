# Changelog

## 1.1.0

### Ajouts
- **Workflow** :
  - `addParallelStep` (branches exécutées en parallèle, fusion des mises à jour, annulation des branches sœurs en cas d'échec) ;
  - retry et timeout par étape, `AbortSignal`, hooks `onStepStart`/`onStepEnd`/`onError`, `runWithTrace()` ;
  - checkpoints (`MemoryCheckpointAdapter`, `FileCheckpointAdapter`) et `resume(runId)` ;
  - validation du graphe avant exécution, constante `END`, cibles déclarées pour `addConditionalEdge`, `WorkflowError` ;
  - mode `strict`, option `validate: "each-step" | "end" | "none"`, et `Workflow.fromSchema()`.
- **Agent** :
  - option `{ signal }` sur `run` / `runStream` ;
  - `retry.timeoutMs` ;
  - `context.maxMessages` et `context.maxToolResultChars` ;
  - `toolCallFormat` ;
  - `mcpStrict`.
- Exports : `StreamTagParser`, `extractToolCalls`.

### Corrections
- Les appels de correction de sortie structurée comptent désormais dans l'usage et le budget, et passent par le hook `beforeLLMCall`.
- `runStream` applique les guardrails, appelle `afterLLMCall` à chaque tour et sauvegarde l'historique.
- Les `run()` concurrents sur une même instance sont sérialisés, et l'initialisation n'a lieu qu'une seule fois.
- Streaming : la connexion est fermée quand le consommateur s'arrête avant la fin, et un dernier événement SSE sans saut de ligne final n'est plus perdu.
- MCP : les collisions de noms entre serveurs sont gérées, les échecs de connexion sont journalisés, et les connexions sont établies en parallèle.
- `FileHistoryAdapter` : les `sessionId` qui permettraient de sortir du dossier sont refusés (path traversal), l'écriture est atomique et le JSON compact.

### Performances
- Les schémas JSON des outils et de la sortie structurée sont mis en cache, au lieu d'être recalculés à chaque itération.
- Build sans obfuscation : JS lisible, source maps et paquet plus léger.

### Changements de comportement
- Niveau de log par défaut : `warn` (au lieu de `error`).
- Résultats d'outils MCP aplatis en texte ; `isError` devient une erreur.
- `runStreamStructured` fait 3 tentatives de correction par défaut.
- Un JSON nu n'est pris pour un appel d'outil que si son `name` correspond à un outil enregistré.
- Après une correction réussie, l'historique ne garde que la réponse valide.
- Un échec d'étape de workflow lève une `WorkflowError` (l'erreur d'origine est dans `cause`).
- Node.js ≥ 20.3 requis.
