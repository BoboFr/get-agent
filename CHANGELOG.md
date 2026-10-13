# Changelog

## 1.3.0

### Ajouts
- **Guardrails sur les résultats d'outils** (`guardrails.toolResults`), contre l'injection de prompt indirecte et les fuites de données personnelles. Un résultat bloqué est remplacé par un message d'erreur pour le modèle, ou fait échouer le run avec `onToolResultBlocked: "throw"`.
- `promptInjection()` : détection des tentatives d'injection courantes (anglais et français) et des jetons de contrôle de modèle.
- `llmGuardrail({ agent, policy })` : un agent classifieur juge le texte selon une politique (sortie structurée).
- `GuardrailError` (`stage`, `guardrail`, `reason`, `cause`) et `defineGuardrail(name, fn)` pour nommer ses guardrails.
- Second paramètre `ctx` passé aux guardrails : `stage`, `agentName`, `messages`, `toolName`, `signal`.
- `guardrails.parallelInput` : le premier appel LLM part pendant les vérifications d'entrée ; il est annulé si l'entrée est bloquée, et relancé si elle est assainie.
- `guardrails.streamOutput: "buffer"` : en streaming, la réponse finale n'est émise qu'après validation.
- `redactPII({ categories, replacement })` : choix des catégories (`email`, `iban`, `card`, `frSsn`, `phone`, `ip`) et du texte de remplacement.
- `applyGuardrails` est exporté.

### Corrections
- `blockedPatterns` : une regex avec le drapeau `g` ne laisse plus passer un texte une fois sur deux.
- `redactPII` : les dates, montants et numéros de commande ne sont plus masqués comme des téléphones ; les numéros de carte sont reconnus (vérification de Luhn) ; ajout des IBAN (somme de contrôle) et des numéros de sécurité sociale français (clé vérifiée) ; téléphones français et internationaux plus stricts.
- Les guardrails d'entrée s'appliquent aussi quand `run()` reçoit une liste de messages, et aux parties texte des messages multimodaux.
- Les guardrails de sortie s'appliquent aussi aux sorties structurées (`run` avec `schema`, `runStreamStructured`).
- Une réponse assainie remplace aussi la réponse brute dans l'historique : elle n'est plus renvoyée au modèle ni sauvegardée.
- Un tour bloqué par un guardrail est retiré de l'historique.

### Changements de comportement
- Un blocage lève une `GuardrailError` (sous-classe d'`Error`, message toujours préfixé par `[Guardrail]`).
- Le message d'un blocage sans raison indique l'étape et le guardrail (« Output blocked by guardrail 'x'. » au lieu de « Input blocked by guardrail. »).
- `blockedPatterns` accepte aussi des chaînes, qui sont recherchées sans tenir compte de la casse.

## 1.2.0

### Ajouts
- **Agent Skills** : prise en charge du [format ouvert Agent Skills](https://agentskills.io) (dossiers `SKILL.md`).
  - Option `agentSkills` de l'agent : un dossier de skills, un dossier de skill, ou des skills déjà chargées.
  - Chargement progressif : seuls le nom et la description vont dans le prompt système ; le modèle charge les instructions avec l'outil `load_skill` et lit les fichiers annexes avec `read_skill_file` (les chemins hors du dossier sont refusés).
  - Validation des en-têtes selon la spécification (`name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`).
  - Fonctions exportées : `loadAgentSkills`, `loadAgentSkill`, `agentSkillsPrompt`, `createAgentSkillTools`, `readAgentSkillInstructions`, `listAgentSkillFiles`, `readAgentSkillFile`, et la méthode `agent.getAgentSkills()`.
  - Les scripts fournis par une skill ne sont jamais exécutés.

### Changements
- `Skill` est renommé `Toolkit`, pour ne plus le confondre avec les Agent Skills : `createToolkit`, `ToolkitConfig`, option `toolkits`, méthodes `addToolkit`, `removeToolkit` et `getRegisteredToolkits`.
- Les anciens noms (`Skill`, `createSkill`, `SkillConfig`, option `skills`, `addSkill`, `removeSkill`, `getRegisteredSkills`) restent disponibles mais sont dépréciés, et seront retirés en 2.0.

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
