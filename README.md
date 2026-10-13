<div align="center">

# GetAgent

**Agents IA et workflows typés en TypeScript, pensés pour les LLM locaux comme pour les API distantes.**

[![npm](https://img.shields.io/npm/v/@thegetget/get-agent?color=cb3837&logo=npm)](https://www.npmjs.com/package/@thegetget/get-agent)
[![license](https://img.shields.io/npm/l/@thegetget/get-agent)](#licence)
[![node](https://img.shields.io/node/v/@thegetget/get-agent?logo=node.js&logoColor=white)](https://nodejs.org)
[![types](https://img.shields.io/npm/types/@thegetget/get-agent?logo=typescript&logoColor=white)](https://www.typescriptlang.org)

[Démarrage rapide](#démarrage-rapide) · [Concepts](#concepts) · [Workflows](#workflows) · [Production](#en-production) · [Référence API](#référence-api) · [Exemples](./examples)

</div>

---

GetAgent fournit la boucle agent (LLM → outils → LLM), la validation Zod de bout en bout, le support MCP et un moteur de workflows à base de graphe, dans un paquet léger sans framework imposé. Il fonctionne avec n'importe quelle API compatible OpenAI : llama.cpp, Ollama, vLLM, LM Studio, OpenAI, OpenRouter…

```ts
import { Agent, createTool } from "@thegetget/get-agent";
import { z } from "zod";

const meteo = createTool(
  "meteo",
  "Donne la météo actuelle d'une ville.",
  z.object({ ville: z.string() }),
  async ({ ville }) => ({ ville, temperature: 21, ciel: "dégagé" })
);

const agent = new Agent({ name: "assistant", model: "qwen3-8b", tools: [meteo] });

console.log(await agent.run("Quel temps fait-il à Lyon ?"));
```

## Pourquoi GetAgent

- **Typé de bout en bout.** Les arguments des outils, les sorties structurées et l'état des workflows sont décrits avec Zod, validés à l'exécution et inférés par TypeScript.
- **Compatible avec les modèles locaux.** Les appels d'outils sont reconnus même quand le modèle ne suit pas l'API `tool_calls` : balises Hermes/Qwen `<tool_call>`, marqueurs LFM, JSON nu, syntaxe pythonique. Les arguments `"42"` sont convertis en nombres quand le schéma l'exige.
- **Prêt pour la production.** Retries avec backoff, timeouts, `AbortSignal`, budget en tokens et en dollars, guardrails, hooks, logs structurés, persistance de l'historique.
- **Agent Skills.** Les dossiers `SKILL.md` au [format ouvert Agent Skills](https://agentskills.io) se branchent directement : le modèle ne voit que leur nom et leur description, et charge les instructions seulement quand la tâche le demande.
- **Workflows durables.** Graphe d'étapes avec branches conditionnelles, étapes parallèles, retry par étape, trace d'exécution, checkpoints et reprise après échec.
- **Léger.** Une dépendance d'exécution (`@modelcontextprotocol/sdk`), Zod en peer dependency, `fetch` natif, ESM.

## Sommaire

- [Installation](#installation)
- [Démarrage rapide](#démarrage-rapide)
- [Concepts](#concepts) : [Agent](#agent) · [Outils](#outils) · [Sortie structurée](#sortie-structurée) · [Streaming](#streaming) · [Multimodal](#multimodal) · [MCP](#mcp) · [Toolkits](#toolkits) · [Agent Skills](#agent-skills) · [Multi-agents](#multi-agents)
- [Workflows](#workflows)
- [En production](#en-production) : [Hooks](#hooks) · [Approbation humaine](#approbation-humaine) · [Guardrails](#guardrails) · [Budget](#budget-et-consommation) · [Historique](#persistance-de-lhistorique) · [Fiabilité](#fiabilité-et-annulation) · [Logs](#logs)
- [Référence API](#référence-api)
- [Exemples](#exemples)
- [Développement](#développement)

## Installation

```bash
npm install @thegetget/get-agent zod@^4
```

| Prérequis | Version |
| --- | --- |
| Node.js | ≥ 20.3 |
| Zod | ^4.0.0 (peer dependency) |
| Module | ESM uniquement |

> [!IMPORTANT]
> GetAgent utilise le convertisseur natif `z.toJSONSchema()` de **Zod v4**. Avec Zod v3, TypeScript renvoie une erreur `TS2740` dès qu'un schéma est passé à l'agent.

## Démarrage rapide

**1. Lancez un modèle** sur un serveur compatible OpenAI, par exemple avec llama.cpp :

```bash
llama-server -m Qwen3-8B-Q4_K_M.gguf --port 8080 --jinja
```

**2. Créez un agent** qui pointe vers ce serveur :

```ts
import { Agent } from "@thegetget/get-agent";

const agent = new Agent({
  name: "assistant",
  baseUrl: "http://127.0.0.1:8080/v1", // valeur par défaut
  model: "qwen3-8b",
  systemPrompt: "Tu réponds en français, de façon concise.",
});

console.log(await agent.run("Explique le protocole MCP en une phrase."));
```

Pour une API hébergée, renseignez `baseUrl` et `apiKey` :

```ts
const agent = new Agent({
  name: "assistant",
  baseUrl: "https://api.openai.com/v1",
  apiKey: process.env.OPENAI_API_KEY,
  model: "gpt-4o-mini",
});
```

## Concepts

### Agent

Un `Agent` encapsule un modèle, un prompt système, des outils et un historique de conversation. `run()` exécute la boucle : il appelle le LLM, exécute les outils demandés, renvoie les résultats au LLM, et recommence jusqu'à obtenir une réponse finale (limite fixée par `maxIterations`).

```ts
await agent.run("Bonjour, je m'appelle Léa.");
await agent.run("Comment je m'appelle ?"); // l'historique est conservé entre les appels

agent.getHistory();   // messages échangés
agent.clearHistory(); // repartir de zéro
```

`run()` accepte aussi une liste de messages, qui remplace alors l'historique :

```ts
await agent.run([
  { role: "user", content: "Combien font 2 + 2 ?" },
  { role: "assistant", content: "4" },
  { role: "user", content: "Et multiplié par 10 ?" },
]);
```

> [!NOTE]
> Les appels `run` / `runStream` sur une **même instance** sont mis en file, car ils partagent l'historique. Pour traiter des requêtes en parallèle, créez une instance par requête ou par session.

### Outils

`createTool` associe un nom, une description destinée au modèle, un schéma Zod et une fonction. Les arguments sont validés avant l'exécution ; en cas d'erreur, le modèle reçoit le message de validation et peut corriger son appel.

```ts
import { createTool } from "@thegetget/get-agent";
import { z } from "zod";

const calculTva = createTool(
  "calcul_tva",
  "Calcule la TVA et le prix TTC à partir d'un prix hors taxes.",
  z.object({
    prixHT: z.number().describe("Prix hors taxes en euros"),
    taux: z.number().default(20).describe("Taux de TVA en pourcentage"),
  }),
  ({ prixHT, taux }) => ({ tva: prixHT * (taux / 100), ttc: prixHT * (1 + taux / 100) })
);

const agent = new Agent({ name: "comptable", tools: [calculTva], parallelTools: true });
```

Avec `parallelTools: true`, les appels d'outils demandés dans un même tour s'exécutent en parallèle.

### Sortie structurée

Passez un schéma Zod : le résultat est validé et typé. Si la réponse du modèle n'est pas valide, l'agent lui renvoie l'erreur et lui demande de corriger (3 tentatives par défaut).

```ts
const Profil = z.object({
  nom: z.string(),
  age: z.number(),
  competences: z.array(z.string()),
});

const profil = await agent.run(
  "Thomas a 28 ans et maîtrise TypeScript, React et Node.js.",
  { schema: Profil, maxRetries: 2 }
);
// profil : { nom: string; age: number; competences: string[] }
```

### Streaming

`runStream()` renvoie un `AsyncGenerator` de fragments de texte. Les appels d'outils sont exécutés en coulisse ; seul le texte destiné à l'utilisateur est émis.

```ts
for await (const chunk of agent.runStream("Raconte une histoire courte.")) {
  process.stdout.write(chunk);
}
```

Le raisonnement des modèles (`<think>…</think>` ou champ `reasoning_content`) est émis sous forme de bloc `<think>`. Pour le masquer, passez `showThinking: false`.

Pour diffuser le texte **et** obtenir un objet validé à la fin :

```ts
const { stream, result } = agent.runStreamStructured("Propose un titre et 5 mots-clés.", {
  schema: z.object({ titre: z.string(), motsCles: z.array(z.string()) }),
});

for await (const chunk of stream) process.stdout.write(chunk);
const { titre, motsCles } = await result;
```

### Multimodal

Les images, documents et fichiers audio sont envoyés au format *content parts* d'OpenAI. Des helpers construisent ces messages pour vous :

```ts
import { userMessage, imageFromFile, imageFromUrl, fileFromPath } from "@thegetget/get-agent";

await agent.run([
  userMessage(
    "Compare ces deux visuels avec le cahier des charges.",
    await imageFromFile("./v1.png"),          // MIME déduit de l'extension
    imageFromUrl("https://exemple.com/v2.jpg"),
    await fileFromPath("./cahier-des-charges.pdf")
  ),
]);
```

Helpers disponibles : `text`, `imageFromUrl`, `imageFromBase64`, `imageFromBuffer`, `imageFromFile`, `fileFromBase64`, `fileFromBuffer`, `fileFromPath`, `fileFromId`, `toDataUrl`, `userMessage`.

### MCP

Les serveurs [Model Context Protocol](https://modelcontextprotocol.io) (transport stdio) se connectent en parallèle à l'initialisation, et leurs outils sont exposés à l'agent comme des outils locaux.

```ts
const agent = new Agent({
  name: "fichiers",
  mcpServers: [
    {
      name: "filesystem",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "./docs"],
    },
  ],
  mcpStrict: true, // un serveur injoignable fait échouer initialize() (sinon : simple avertissement)
});

console.log(await agent.run("Liste les fichiers Markdown du dossier."));
await agent.shutdown(); // ferme les connexions MCP
```

Si deux serveurs exposent le même nom d'outil, celui du second est préfixé par le nom du serveur (`<serveur>_<outil>`).

### Toolkits

Un toolkit regroupe des outils, des instructions ajoutées au prompt système et des hooks `initialize` / `shutdown`. Les noms de ses outils sont préfixés par le nom du toolkit (`math_calculer`), sauf avec `prefixToolNames: false`.

```ts
import { createToolkit } from "@thegetget/get-agent";

const math = createToolkit({
  name: "math",
  description: "Calcul et conversions d'unités",
  tools: [calculer, convertir],
  systemPrompt: "Utilise les outils math_* pour tout calcul.",
  initialize: async () => { /* ouvrir une connexion, charger un cache… */ },
  shutdown: async () => { /* libérer les ressources */ },
});

const agent = new Agent({ name: "assistant", toolkits: [math] });

await agent.addToolkit(autreToolkit); // ajout à chaud
await agent.removeToolkit("math");    // retrait à chaud (appelle shutdown)
```

> [!NOTE]
> Jusqu'à la version 1.1, les toolkits s'appelaient « skills » (`createSkill`, `skills`, `addSkill`…). Ces noms fonctionnent toujours mais sont dépréciés, et seront retirés en 2.0.

### Agent Skills

Une [Agent Skill](https://agentskills.io) est un dossier qui contient un fichier `SKILL.md` : un en-tête YAML (`name`, `description`) suivi d'instructions en Markdown, avec éventuellement des fichiers annexes (`references/`, `scripts/`, `assets/`).

```
skills/
└── message-de-commit/
    ├── SKILL.md
    └── references/
        └── exemples.md
```

```markdown
---
name: message-de-commit
description: Rédige des messages de commit au format Conventional Commits. À utiliser dès qu'on demande un message de commit.
---

# Message de commit

1. Identifie le type du changement : feat, fix, refactor, docs…
2. Écris le sujet à l'impératif, en 72 caractères maximum.

Consulte `references/exemples.md` avant de répondre.
```

Indiquez à l'agent le dossier des skills :

```ts
const agent = new Agent({
  name: "assistant",
  agentSkills: ["./skills"], // dossier de skills, dossier d'une skill, ou skills déjà chargées
});

await agent.run("J'ai ajouté la réinitialisation du mot de passe. Propose un message de commit.");
```

Le chargement est **progressif**, pour ne pas encombrer le contexte :

1. **Au démarrage**, seuls le nom et la description de chaque skill sont ajoutés au prompt système.
2. **Quand une tâche correspond à une skill**, le modèle appelle l'outil `load_skill` et reçoit les instructions de `SKILL.md` ainsi que la liste des fichiers annexes.
3. **Si les instructions le demandent**, il lit un fichier annexe avec `read_skill_file`. Les chemins qui sortent du dossier de la skill sont refusés.

Les en-têtes sont validés selon la spécification : `name` en minuscules, chiffres et tirets, identique au nom du dossier ; `description` obligatoire, 1 024 caractères au maximum. Les champs `license`, `compatibility`, `metadata` et `allowed-tools` sont lus et exposés sur l'objet `AgentSkill`.

> [!IMPORTANT]
> GetAgent **n'exécute jamais** les scripts fournis par une skill : `read_skill_file` ne fait que les lire. Si vos skills ont besoin d'exécuter du code, fournissez vous-même l'outil correspondant, de préférence avec `requiresApproval`.

Pour composer votre propre mécanisme, les fonctions sous-jacentes sont exportées : `loadAgentSkills`, `loadAgentSkill`, `agentSkillsPrompt`, `createAgentSkillTools`, `readAgentSkillInstructions`, `listAgentSkillFiles`, `readAgentSkillFile`.

### Multi-agents

`createAgentTool` expose un agent comme un outil, ce qui permet à un agent orchestrateur de déléguer des tâches à des agents spécialisés.

```ts
import { createAgentTool } from "@thegetget/get-agent";

const traducteur = new Agent({
  name: "traducteur",
  systemPrompt: "Traduis fidèlement vers l'anglais. Réponds uniquement avec la traduction.",
});

const orchestrateur = new Agent({
  name: "orchestrateur",
  tools: [
    createAgentTool(traducteur, {
      name: "traduire_en_anglais",
      description: "Traduit un texte français vers l'anglais.",
      keepHistory: false, // historique du sous-agent réinitialisé à chaque appel (défaut)
    }),
  ],
});
```

> [!WARNING]
> Un agent ne doit pas être son propre outil : ses appels étant mis en file, il attendrait indéfiniment sa propre réponse.

## Workflows

Un `Workflow` est un graphe d'étapes qui partagent un état. Chaque étape reçoit l'état et renvoie une mise à jour partielle ; les arêtes, simples ou conditionnelles, choisissent l'étape suivante.

```ts
import { Workflow, END } from "@thegetget/get-agent";
import { z } from "zod";

const Etat = z.object({
  question: z.string(),
  brouillon: z.string().default(""),
  note: z.number().default(0),
  tentatives: z.number().default(0),
});

const wf = Workflow.fromSchema(Etat, { name: "redaction", maxSteps: 12 })
  .addStep("rediger", async (s) => ({
    brouillon: await redacteur.run(s.question),
    tentatives: s.tentatives + 1,
  }))
  .addStep("noter", async (s) => {
    const { note } = await juge.run(s.brouillon, { schema: z.object({ note: z.number() }) });
    return { note };
  })
  .setStart("rediger")
  .addEdge("rediger", "noter")
  .addConditionalEdge(
    "noter",
    (s) => (s.note >= 8 || s.tentatives >= 3 ? END : "rediger"),
    ["rediger", END] // cibles possibles, vérifiées avant l'exécution
  );

const final = await wf.run({ question: "Explique l'intérêt des agents IA en entreprise." });
```

`Workflow.fromSchema` déduit les types de l'état à partir du schéma : les champs qui ont un `.default()` deviennent facultatifs en entrée. `new Workflow<Etat>({ ... })` reste disponible si vous préférez déclarer le type vous-même.

Le graphe est vérifié au premier `run()` : une étape de départ manquante ou une arête vers une étape inexistante est signalée **avant** d'exécuter la moindre étape.

### Étapes parallèles

Les branches d'une étape parallèle s'exécutent en même temps, sur une copie figée de l'état. Leurs mises à jour sont ensuite fusionnées : si deux branches écrivent la même clé, c'est une erreur, sauf si vous fournissez une fonction `merge`. Quand une branche échoue, le `signal` des autres est annulé.

```ts
wf.addParallelStep("analyser", {
  sentiment: async (s, ctx) => ({ sentiment: await classer(s.avis, ctx.signal) }),
  themes: async (s) => ({ themes: await extraireThemes(s.avis) }),
});
```

### Retry, timeout et annulation

```ts
wf.addStep("appeler_api", appelerApi, { retries: 2, retryDelayMs: 1_000, timeoutMs: 30_000 });

const controller = new AbortController();
await wf.run(etat, { signal: controller.signal });
```

Chaque étape reçoit un contexte `ctx` : `{ signal, step, stepCount, attempt, branch? }`. Transmettez `ctx.signal` à vos appels (`agent.run(prompt, { signal: ctx.signal })`) pour qu'un timeout ou une annulation les interrompe réellement.

### Observabilité

```ts
const wf = Workflow.fromSchema(Etat, {
  name: "redaction",
  hooks: {
    onStepStart: (step, state) => {},
    onStepEnd: (step, { update, state, durationMs, attempts }) => {},
    onError: (step, error, state) => {},
  },
});

const { state, trace } = await wf.runWithTrace(etat);
// trace : [{ step, durationMs, attempts, update, next }, …]
```

Les erreurs sont des `WorkflowError` : elles indiquent l'étape (`step`), le nombre d'étapes déjà exécutées (`stepCount`), l'état à cet instant (`state`) et l'erreur d'origine (`cause`).

### Checkpoints et reprise

Avec un adaptateur de checkpoint et un `runId`, l'état est sauvegardé après chaque étape. Un run interrompu (plantage, redémarrage, panne réseau) reprend à la première étape non terminée.

```ts
import { FileCheckpointAdapter } from "@thegetget/get-agent";

const wf = Workflow.fromSchema(Etat, {
  name: "redaction",
  checkpoint: new FileCheckpointAdapter(".workflow-checkpoints"),
});

await wf.run(etat, { runId: "commande-1234" });

// plus tard, éventuellement dans un autre processus :
const { state } = await wf.resume("commande-1234");
```

Deux adaptateurs sont fournis, `MemoryCheckpointAdapter` et `FileCheckpointAdapter`. Pour stocker ailleurs (Redis, Postgres…), implémentez l'interface `CheckpointAdapter` (`save`, `load`, `clear`). L'état doit être sérialisable en JSON.

### Options du workflow

| Option | Défaut | Description |
| --- | --- | --- |
| `stateSchema` | — | Schéma Zod de l'état (fourni automatiquement par `fromSchema`). |
| `validate` | `"each-step"` | Quand valider l'état : `"each-step"`, `"end"` (au début et à la fin seulement) ou `"none"`. |
| `strict` | `false` | Chaque étape doit avoir une arête sortante, et l'état passé aux étapes est figé (`Object.freeze`). |
| `maxSteps` | `100` | Nombre maximal d'étapes exécutées, pour se protéger des boucles infinies. |
| `hooks` | — | `onStepStart`, `onStepEnd`, `onError`. |
| `checkpoint` | — | Adaptateur de persistance pour `run(…, { runId })` et `resume()`. |
| `logger` / `verbose` | — | Journalisation (voir [Logs](#logs)). |

> [!TIP]
> Ne modifiez pas `state` directement dans une étape : renvoyez une mise à jour. Les clés absentes du schéma sont supprimées par Zod, et un avertissement les liste.

## En production

### Hooks

Les hooks interceptent le cycle de vie de l'agent. Tous sont facultatifs et peuvent être asynchrones.

| Hook | Effet de la valeur renvoyée |
| --- | --- |
| `beforeLLMCall(messages)` | Un tableau remplace les messages envoyés au LLM. |
| `afterLLMCall(content, toolCalls?)` | Aucun (observation : audit, métriques). |
| `beforeToolCall(name, args)` | `false` annule l'appel ; un objet remplace les arguments. |
| `afterToolCall(name, args, result)` | Une valeur remplace le résultat de l'outil. |

```ts
const agent = new Agent({
  name: "assistant",
  tools: [meteo],
  hooks: {
    beforeToolCall: (name, args) => (name === "meteo" ? { ...args, ville: args.ville.trim() } : undefined),
    afterToolCall: (_name, _args, result) => ({ ...result, source: "api-meteo" }),
  },
});
```

### Approbation humaine

Un outil marqué `requiresApproval` n'est exécuté qu'après validation par le callback `onApprovalRequired`. Un refus est transmis au modèle, qui peut adapter sa réponse.

```ts
const supprimer = createTool("supprimer_fichier", "Supprime un fichier.", z.object({ path: z.string() }), rm);
supprimer.requiresApproval = true;

const agent = new Agent({
  name: "gestionnaire",
  tools: [supprimer],
  onApprovalRequired: async (tool, args) => demanderConfirmation(`${tool}(${JSON.stringify(args)})`),
});
```

### Guardrails

Les guardrails filtrent le texte à trois endroits : les messages de l'utilisateur (`input`), la réponse finale (`output`) et les résultats d'outils (`toolResults`). Chaque guardrail peut **bloquer** le texte (le run lève une `GuardrailError`) ou l'**assainir** (le texte est remplacé, y compris dans l'historique).

```ts
import { Agent, maxLength, promptInjection, redactPII, llmGuardrail, GuardrailError } from "@thegetget/get-agent";

const moderateur = new Agent({ name: "moderateur", model: "qwen3-1.7b", temperature: 0 });

const agent = new Agent({
  name: "support",
  guardrails: {
    input: [
      maxLength(4_000),
      promptInjection(),
      llmGuardrail({ agent: moderateur, policy: "Seules les questions sur nos produits et commandes sont acceptées." }),
    ],
    output: [redactPII()],
    toolResults: [promptInjection(), redactPII()], // pages web, fichiers, API…
    parallelInput: true,   // lance le premier appel LLM pendant les vérifications d'entrée
    streamOutput: "buffer" // en streaming, la réponse n'est émise qu'une fois validée
  },
});

try {
  await agent.run(question);
} catch (err) {
  if (err instanceof GuardrailError) {
    console.log(err.stage, err.guardrail, err.reason); // "input", "promptInjection", "Possible prompt injection detected."
  } else throw err;
}
```

**Guardrails fournis**

| Guardrail | Effet |
| --- | --- |
| `maxLength(n)` | Bloque un texte de plus de `n` caractères. |
| `blockedPatterns(motifs, raison?)` | Bloque un texte qui contient une chaîne (sans tenir compte de la casse) ou qui correspond à une regex. |
| `promptInjection({ extraPatterns? })` | Bloque les tentatives d'injection courantes, en anglais et en français (« ignore les instructions précédentes », « révèle ton prompt système »…), ainsi que les jetons de contrôle de modèle (`<\|im_start\|>`, `[INST]`…). |
| `redactPII({ categories?, replacement? })` | Masque les e-mails, IBAN et numéros de carte (sommes de contrôle vérifiées), numéros de sécurité sociale (clé vérifiée) et téléphones français ou internationaux. Les IP peuvent être ajoutées avec `categories`. Dates, montants et numéros de commande ne sont pas touchés. |
| `llmGuardrail({ agent, policy, failOpen? })` | Fait juger le texte par un agent classifieur (sortie structurée `{ allowed, reason }`). Le texte lui est présenté comme une donnée, pour qu'il n'en suive pas les instructions. |
| `sanitize(fn)` | Transforme le texte, sans jamais bloquer. |

**Écrire son propre guardrail**

Un guardrail est une fonction `(texte, ctx) => { allowed, reason?, sanitized? }`, synchrone ou asynchrone. `ctx` contient `stage`, `agentName`, `messages` (l'historique), `toolName` pour un résultat d'outil, et `signal`. `defineGuardrail` lui donne un nom, repris dans les erreurs :

```ts
import { defineGuardrail } from "@thegetget/get-agent";

const pasDeConcurrents = defineGuardrail("concurrents", (texte) =>
  /\b(acme|globex)\b/i.test(texte)
    ? { allowed: false, reason: "Nous ne commentons pas les concurrents." }
    : { allowed: true }
);
```

**Comportement détaillé**

| Étape | Ce qui est vérifié | En cas de blocage |
| --- | --- | --- |
| `input` | Les messages utilisateur du nouveau tour : la chaîne passée à `run()`, ou les messages qui suivent la dernière réponse de l'assistant quand vous passez une liste. Pour un message multimodal, chaque partie texte est vérifiée ; les images, fichiers et sons ne sont pas inspectés. | `GuardrailError`, et le tour est retiré de l'historique. |
| `output` | La réponse finale, y compris une sortie structurée (vérifiée sous forme de JSON, puis validée à nouveau contre le schéma si elle a été assainie). | `GuardrailError`, et le tour est retiré de l'historique. |
| `toolResults` | Chaque résultat d'outil, tel que le modèle le verra (après la troncature `context.maxToolResultChars`). | Le résultat est remplacé par un message d'erreur pour le modèle. Avec `onToolResultBlocked: "throw"`, le run échoue. |

- Les guardrails s'exécutent dans l'ordre, et chacun reçoit le texte assaini par les précédents. Si un guardrail lève une exception, le texte est refusé (`GuardrailError` avec l'erreur d'origine dans `cause`).
- Avec `parallelInput`, le premier appel LLM part en même temps que les vérifications d'entrée. Si l'entrée est bloquée, l'appel est annulé ; si elle est assainie, l'appel est relancé avec le texte assaini, de sorte que le texte brut n'est jamais utilisé pour la réponse. C'est surtout utile avec `llmGuardrail`.
- En streaming, `streamOutput: "after"` (par défaut) diffuse le texte en direct et vérifie la réponse une fois terminée : un blocage arrive donc après l'affichage. `"buffer"` retient la réponse finale, la vérifie, puis l'émet en un seul fragment.

> [!WARNING]
> `promptInjection()` repose sur des motifs : il arrête les tentatives courantes, pas un attaquant déterminé. Pour un usage sensible, combinez-le avec `llmGuardrail`, et appliquez-le aussi aux `toolResults`, par où arrivent la plupart des injections (pages web, e-mails, documents).

### Budget et consommation

```ts
const agent = new Agent({
  name: "assistant",
  budget: {
    maxTokens: 100_000,
    maxCostUSD: 0.5,
    pricing: { inputPerMToken: 0.15, outputPerMToken: 0.6 },
  },
});

await agent.run("…");
agent.getUsage(); // { totalPromptTokens, totalCompletionTokens, totalTokens, llmCallCount, estimatedCostUSD }
```

Dès qu'un plafond est atteint, le run lève une erreur `[Budget]`. Les tentatives de correction de sortie structurée sont comptées dans la consommation.

### Persistance de l'historique

```ts
import { FileHistoryAdapter } from "@thegetget/get-agent";

const agent = new Agent({
  name: "assistant",
  historyAdapter: new FileHistoryAdapter(".agent-history"), // un fichier JSON par session
  sessionId: "utilisateur-42",
});
```

L'historique est chargé à l'initialisation et sauvegardé après chaque run. Pour utiliser une base de données ou un cache, implémentez l'interface `HistoryAdapter` (`load`, `save`, `clear`).

### Fiabilité et annulation

```ts
const agent = new Agent({
  name: "assistant",
  retry: {
    maxRetries: 3,          // tentatives supplémentaires après l'échec initial
    initialDelayMs: 500,    // backoff exponentiel avec jitter
    maxDelayMs: 10_000,
    timeoutMs: 30_000,      // par tentative (en streaming : jusqu'à la réception des en-têtes)
  },
  context: {
    maxMessages: 40,           // ne transmet au LLM que les 40 derniers messages (+ prompt système)
    maxToolResultChars: 20_000 // tronque les résultats d'outils volumineux
  },
});

const controller = new AbortController();
await agent.run("…", { signal: controller.signal });
```

- Les codes 429 et 5xx ainsi que les erreurs réseau sont retentés, et l'en-tête `Retry-After` est respecté. Une annulation demandée par l'appelant n'est jamais retentée.
- `context.maxMessages` réduit uniquement ce qui est envoyé au LLM : l'historique stocké reste complet, et un appel d'outil n'est jamais séparé de son résultat.

### Logs

```ts
const agent = new Agent({
  name: "assistant",
  logger: {
    level: "info",                            // debug | info | warn | error
    format: "json",                           // text | json
    transport: (entry) => monService.log(entry), // remplace la sortie console
  },
});
```

`verbose: true` est un raccourci pour obtenir les logs `debug` sur la console.

## Référence API

### `new Agent(config)`

| Option | Type | Défaut | Description |
| --- | --- | --- | --- |
| `name` | `string` | **requis** | Nom de l'agent (utilisé dans les logs). |
| `model` | `string` | `""` | Nom du modèle envoyé à l'API. |
| `baseUrl` | `string` | `"http://127.0.0.1:8080/v1"` | URL d'une API compatible OpenAI. |
| `apiKey` | `string` | — | Clé envoyée en `Authorization: Bearer`. |
| `systemPrompt` | `string` | `"You are a helpful AI assistant."` | Prompt système. Les prompts des toolkits et le catalogue des Agent Skills y sont ajoutés. |
| `temperature` | `number` | `0.2` | Température d'échantillonnage. |
| `maxIterations` | `number` | `10` | Nombre maximal de tours LLM ↔ outils par run. |
| `tools` | `Tool[]` | `[]` | Outils locaux. |
| `toolkits` | `Toolkit[]` | `[]` | Voir [Toolkits](#toolkits). `skills` reste accepté (déprécié). |
| `agentSkills` | `Array<string \| AgentSkill>` | `[]` | Voir [Agent Skills](#agent-skills). |
| `mcpServers` | `McpServerConfig[]` | `[]` | Serveurs MCP (stdio). |
| `mcpStrict` | `boolean` | `false` | Fait échouer l'initialisation si un serveur MCP est injoignable. |
| `parallelTools` | `boolean` | `false` | Exécute en parallèle les outils demandés dans un même tour. |
| `toolCallFormat` | `"auto" \| "native" \| "lfm"` | `"auto"` | `"lfm"` ajoute la liste des outils au prompt système (modèles LiquidAI). |
| `showThinking` | `boolean` | `true` | Conserve les blocs `<think>` dans la sortie. |
| `hooks` | `AgentHooks` | — | Voir [Hooks](#hooks). |
| `onApprovalRequired` | `(tool, args) => Promise<boolean>` | — | Voir [Approbation humaine](#approbation-humaine). |
| `guardrails` | `{ input?, output? }` | — | Voir [Guardrails](#guardrails). |
| `budget` | `BudgetConfig` | — | Voir [Budget](#budget-et-consommation). |
| `retry` | `RetryConfig` | voir [Fiabilité](#fiabilité-et-annulation) | Retries, backoff et timeout des appels LLM. |
| `context` | `ContextConfig` | — | Limite les messages envoyés et la taille des résultats d'outils. |
| `historyAdapter` / `sessionId` | `HistoryAdapter` / `string` | — | Voir [Historique](#persistance-de-lhistorique). |
| `logger` / `verbose` | `LoggerConfig` / `boolean` | `warn` | Voir [Logs](#logs). |

### Méthodes de `Agent`

| Méthode | Description |
| --- | --- |
| `run(input, options?)` | Exécute la boucle agent. Avec `{ schema }`, renvoie un objet validé ; accepte aussi `{ signal }`. |
| `runStream(input, options?)` | `AsyncGenerator<string>` du texte de la réponse. |
| `runStreamStructured(input, config)` | `{ stream, result }` : texte diffusé, puis objet validé. |
| `repl(options?)` | Session interactive dans le terminal (`/exit`, `/clear`, `/usage`, `/tools`, `/help`). |
| `initialize()` / `shutdown()` | Connexion et libération des ressources (MCP, toolkits, Agent Skills). `initialize()` est appelé automatiquement au premier run. |
| `addToolkit(toolkit)` / `removeToolkit(name)` | Ajout et retrait de toolkits à chaud. |
| `getRegisteredTools()` / `getRegisteredToolkits()` / `getAgentSkills()` | Outils, toolkits et Agent Skills disponibles. |
| `getHistory()` / `clearHistory()` | Lecture et réinitialisation de l'historique. |
| `getUsage()` / `clearUsage()` | Consommation cumulée et coût estimé. |

### Méthodes de `Workflow`

| Méthode | Description |
| --- | --- |
| `Workflow.fromSchema(schema, config)` | Crée un workflow typé à partir d'un schéma Zod. |
| `addStep(name, fn, options?)` | Ajoute une étape ; `options` : `{ retries, retryDelayMs, timeoutMs }`. |
| `addParallelStep(name, branches, options?)` | Ajoute une étape dont les branches s'exécutent en parallèle ; `options.merge` est facultatif. |
| `addEdge(from, to)` | Transition fixe (`to` peut valoir `END`). |
| `addConditionalEdge(from, fn, targets?)` | Transition calculée à partir de l'état. |
| `setStart(name)` | Définit l'étape de départ. |
| `validate()` | Vérifie le graphe (appelé automatiquement au premier run). |
| `run(state, { signal?, runId? })` | Exécute le workflow et renvoie l'état final. |
| `runWithTrace(state, options?)` | Renvoie `{ state, trace }`. |
| `resume(runId, { signal? })` | Reprend un run depuis son dernier checkpoint. |

### Bas niveau

`LLMClient` (client HTTP avec retries), `McpManager`, `StreamTagParser` (analyse incrémentale du texte streamé) et `extractToolCalls` sont exportés pour construire vos propres boucles.

## Exemples

Le dossier [`examples/`](./examples) contient 17 scripts exécutables avec `npx tsx examples/<fichier>.ts` :

| Thème | Exemples |
| --- | --- |
| Bases | [chat et sortie structurée](./examples/01_chat_et_sortie_structuree.ts), [outils](./examples/02_outils.ts), [conversation](./examples/11_chat_conversation.ts), [multimodal](./examples/14_multimodal.ts) |
| Extensions | [toolkits](./examples/03_toolkits.ts), [Agent Skills](./examples/16_agent_skills.ts), [MCP](./examples/04_mcp.ts), [multi-agents](./examples/09_multi_agents.ts) |
| Workflows | [graphe d'étapes](./examples/05_workflow.ts), [scoring](./examples/13_scoring_workflow.ts), [parallèle, checkpoints, reprise](./examples/15_workflow_avance.ts) |
| Production | [streaming et REPL](./examples/06_streaming_et_repl.ts), [hooks](./examples/07_hooks.ts), [approbation humaine](./examples/08_human_in_the_loop.ts), [guardrails avancés](./examples/17_guardrails.ts), [guardrails, budget, logs, persistance](./examples/10_production.ts), [LLM-as-judge](./examples/12_scoring_reponses.ts) |

## Développement

```bash
npm install
npm run typecheck   # vérification des types (src et tests)
npm test            # tests Vitest : fetch simulé, aucun LLM requis
npm run build       # dist/ : JS, déclarations .d.ts et source maps
```

Les évolutions de chaque version sont listées dans le [CHANGELOG](./CHANGELOG.md).

## Licence

[ISC](https://opensource.org/license/isc-license-txt) © Gaëtan BIORD
