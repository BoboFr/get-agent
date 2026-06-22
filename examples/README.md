# Exemples GetAgent

Exemples exécutables couvrant l'ensemble des fonctionnalités du framework.
Ils importent les sources locales (`../src/index.js`) et tournent avec [`tsx`](https://github.com/privatenumber/tsx).

```bash
# Lancer un exemple
npx tsx examples/01_chat_et_sortie_structuree.ts
```

> La plupart des exemples appellent un LLM. Configurez `model` / `baseUrl` / `apiKey`
> dans le constructeur `Agent` (ou via les valeurs par défaut de votre backend
> compatible OpenAI). Les exemples 04 (MCP) et 10 (production) nécessitent
> respectivement un serveur MCP accessible et un accès en écriture disque.

| # | Fichier | Fonctionnalités |
| --- | --- | --- |
| 01 | [01_chat_et_sortie_structuree.ts](01_chat_et_sortie_structuree.ts) | Chat de base, sortie structurée validée par Zod |
| 02 | [02_outils.ts](02_outils.ts) | `createTool`, validation Zod, `parallelTools` |
| 03 | [03_skills.ts](03_skills.ts) | Skills, préfixage, ajout/suppression à chaud |
| 04 | [04_mcp.ts](04_mcp.ts) | Connexion à un serveur MCP (filesystem) |
| 05 | [05_workflow.ts](05_workflow.ts) | Workflow : arêtes simples, conditionnelles, boucle |
| 06 | [06_streaming_et_repl.ts](06_streaming_et_repl.ts) | `runStream`, `runStreamStructured`, `repl` |
| 07 | [07_hooks.ts](07_hooks.ts) | Hooks de cycle de vie (LLM & outils) |
| 08 | [08_human_in_the_loop.ts](08_human_in_the_loop.ts) | `requiresApproval` + `onApprovalRequired` |
| 09 | [09_multi_agents.ts](09_multi_agents.ts) | Agent-as-Tool, orchestration de sous-agents |
| 10 | [10_production.ts](10_production.ts) | Guardrails, budget, logger, retry, persistance |
| 11 | [11_chat_conversation.ts](11_chat_conversation.ts) | Chat multi-tours en streaming, mémoire, `getHistory`, historique pré-rempli |
| 12 | [12_scoring_reponses.ts](12_scoring_reponses.ts) | Scoring de réponses (LLM-as-judge), sortie structurée, boucle d'auto-amélioration |
| 13 | [13_scoring_workflow.ts](13_scoring_workflow.ts) | Scoring orchestré en Workflow (produire → noter → raffiner), garde-fou anti-boucle |

Certains exemples acceptent un argument :

```bash
npx tsx examples/06_streaming_et_repl.ts repl        # session interactive
npx tsx examples/08_human_in_the_loop.ts interactif  # approbation au clavier
```
