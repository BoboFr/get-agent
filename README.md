# GetAgent

GetAgent est un framework léger et puissant en TypeScript permettant de concevoir des agents IA autonomes. Il intègre nativement la validation de schéma avec **Zod**, la création d'outils (tool calling), la connexion à des serveurs **MCP (Model Context Protocol)** et l'orchestration sous forme de **Workflows**.

---

## Fonctionnalités Clés

- 🤖 **Agent Loop autonome** : Résolution de tâches complexes en plusieurs étapes.
- 🛠️ **Outils Typés (Tools)** : Création d'outils simples avec validation automatique des arguments grâce à Zod.
- 🧩 **Skills** : Modules réutilisables regroupant outils, prompt système et hooks de lifecycle.
- 🔌 **Support MCP** : Connexion transparente à n'importe quel serveur MCP standard pour étendre instantanément les capacités de l'agent.
- 🎯 **Sorties Structurées (Structured Output)** : Garantie que la réponse finale de l'agent respecte un schéma Zod précis.
- 🖼️ **Multimodal** : Envoi d'images, de documents (PDF, texte…) et d'audio via des helpers (`imageFromFile`, `fileFromPath`, `userMessage`…).
- ⛓️ **Workflows** : Définition de graphes d'étapes (synchrones ou conditionnels) avec gestion d'état centralisée.
- 📡 **Streaming** : Diffusion des réponses token par token, avec gestion transparente des appels d'outils.
- 🪝 **Hooks / Middleware** : Interception du cycle de vie (avant/après appel LLM, avant/après exécution d'outil).
- 🧑‍⚖️ **Human-in-the-Loop** : Approbation humaine requise avant l'exécution d'outils sensibles.
- 🪆 **Agent-as-Tool** : Exposition d'un agent comme outil appelable par un autre agent (sous-agents).
- 💰 **Budget & Usage** : Suivi des tokens, estimation des coûts et plafonds (tokens / USD).
- 🛡️ **Guardrails** : Filtres d'entrée/sortie (longueur max, motifs bloqués, redaction de PII).
- 💾 **Persistance** : Sauvegarde et reprise de l'historique de conversation entre sessions.
- 📊 **Logger structuré** : Journalisation configurable (niveaux, format texte/JSON, transport personnalisé).
- 🔁 **Robustesse** : Retries avec backoff exponentiel sur les appels LLM et exécution parallèle des outils.

---

## Installation

Installez les dépendances du projet dans votre environnement TypeScript :

```bash
npm install @thegetget/get-agent zod@^4
```

> ⚠️ **Version de Zod requise : v4 (`^4.0.0`).** GetAgent déclare `zod` en `peerDependency` sur la branche v4 et s'appuie sur le convertisseur natif `z.toJSONSchema()`. Si votre projet a encore Zod v3, mettez à jour avec `npm install zod@^4` — sinon vous obtiendrez une erreur de types `TS2740` au passage d'un schéma à `agent.run()` (les classes `ZodType` de v3 et v4 ne sont pas structurellement compatibles).

---

## Exemples Concrets

### 1. Agent Simple (Chat)

Voici comment initialiser et exécuter un agent de base avec un LLM local ou distant compatible OpenAI.

```typescript
import { Agent } from "@thegetget/get-agent";

// Initialisation de l'agent
const agent = new Agent({
  name: "Assistant",
  systemPrompt: "Tu es un traducteur de texte concis en français.",
  model: "Qwen3.5-9B.gguf", // Nom du modèle à utiliser
  baseUrl: "", // URL de votre API compatible OpenAI
  apiKey: "votre-cle-api", // Facultatif
});

// Exécution de l'agent
const response = await agent.run("Translate to French: 'Hello world, how are you today?'");
console.log(response);
```

### 2. Création et Utilisation d'Outils (Tools)

Vous pouvez enrichir votre agent en lui donnant accès à des fonctions personnalisées. Les arguments d'entrée sont automatiquement validés avec Zod.

```typescript
import { Agent, createTool } from "@thegetget/get-agent";
import { z } from "zod";

// 1. Définition de l'outil avec validation Zod
const calculTva = createTool(
  "calculTva",
  "Calcule le montant de la TVA pour un prix hors taxe donné.",
  z.object({
    prixHT: z.number().describe("Le prix hors taxes en euros"),
    taux: z.number().default(20).describe("Le taux de TVA en pourcentage (ex: 20 pour 20%)"),
  }),
  ({ prixHT, taux }) => {
    const montantTVA = prixHT * (taux / 100);
    const prixTTC = prixHT + montantTVA;
    return { montantTVA, prixTTC };
  }
);

// 2. Initialisation de l'agent avec l'outil
const agent = new Agent({
  name: "Comptable",
  model: "Qwen3.5-9B.gguf",
  tools: [calculTva],
});

// L'agent va décider d'appeler l'outil pour répondre à la question
const response = await agent.run("Quel est le montant de la TVA et le prix TTC pour un article à 150€ HT avec un taux de 20% ?");
console.log(response);
```

### 3. Sortie Structurée (Structured Output)

Vous pouvez forcer l'agent à retourner un objet JSON strictement conforme à un schéma Zod.

```typescript
import { Agent } from "@thegetget/get-agent";
import { z } from "zod";

const agent = new Agent({
  name: "Extracteur",
  model: "Qwen3.5-9B.gguf",
});

// Définition du schéma attendu
const schemaProfil = z.object({
  nom: z.string(),
  age: z.number(),
  competences: z.array(z.string()),
});

// Exécution avec le schéma en option
const result = await agent.run(
  "Extrais les informations suivantes du texte : 'Thomas a 28 ans et il maîtrise TypeScript, React et Node.js.'",
  { schema: schemaProfil }
);

// Le résultat est typé et validé
console.log(result);
// Exemple de sortie : { nom: "Thomas", age: 28, competences: [ "TypeScript", "React", "Node.js" ] }
```

### 3.1. Multimodal — Images & Documents

Envoyez des images, des documents (PDF, texte…) ou de l'audio à un modèle multimodal
grâce au format de *content parts* compatible OpenAI. Construisez les messages avec
`userMessage(...)` et les helpers de contenu.

```typescript
import {
  Agent,
  userMessage,
  imageFromUrl,
  imageFromFile,
  fileFromPath,
} from "@thegetget/get-agent";

const agent = new Agent({ name: "Vision", model: "Qwen2.5-VL-7B.gguf" });

// Image distante
await agent.run([
  userMessage("Que vois-tu ?", imageFromUrl("https://exemple.com/photo.jpg")),
]);

// Image locale (lue + encodée en base64 automatiquement, MIME déduit de l'extension)
await agent.run([
  userMessage("Décris cette capture.", await imageFromFile("./screenshot.png")),
]);

// Document local
await agent.run([
  userMessage("Résume ce document.", await fileFromPath("./rapport.pdf")),
]);

// Plusieurs pièces dans un même message
await agent.run([
  userMessage("Compare ces images.", await imageFromFile("./a.png"), await imageFromFile("./b.png")),
]);
```

Helpers disponibles : `text`, `imageFromUrl`, `imageFromBase64`, `imageFromBuffer`,
`imageFromFile`, `fileFromBase64`, `fileFromBuffer`, `fileFromPath`, `fileFromId`,
`toDataUrl`, et le constructeur `userMessage`.

> Nécessite un backend/modèle multimodal (vision). Le champ `Message.content` accepte
> désormais `string | ContentPart[] | null`.

### 4. Connexion aux Serveurs MCP (Model Context Protocol)

GetAgent se connecte automatiquement aux serveurs MCP configurés (via stdio) et expose leurs outils à l'agent.

```typescript
import { Agent } from "@thegetget/get-agent";

const agent = new Agent({
  name: "AgentFichiers",
  model: "Qwen3.5-9B.gguf",
  mcpServers: [
    {
      name: "filesystem",
      command: "node",
      args: ["/chemin/vers/mcp-server-filesystem/dist/index.js", "/dossier/autorise"],
    }
  ]
});

// L'agent utilise les outils fournis par le serveur MCP (ex: list_directory, read_file)
const response = await agent.run("Quels sont les fichiers présents dans le dossier autorisé ?");
console.log(response);
```

### 5. Skills — Modules Réutilisables

Un **Skill** regroupe un ensemble d'outils thématiques, un prompt système additionnel et des hooks de lifecycle (`initialize`/`shutdown`). Les noms des outils sont automatiquement préfixés par le nom du skill pour éviter les collisions.

```typescript
import { Agent, createTool, createSkill } from "@thegetget/get-agent";
import { z } from "zod";

// 1. Définir des outils
const calculTool = createTool(
  "calculate",
  "Évalue une expression mathématique.",
  z.object({ expression: z.string() }),
  ({ expression }) => {
    const result = Function(`"use strict"; return (${expression})`)();
    return { result };
  }
);

const convertTool = createTool(
  "convert_units",
  "Convertit des unités (km/miles, kg/lbs, C/F).",
  z.object({
    value: z.number(),
    from: z.string(),
    to: z.string(),
  }),
  ({ value, from, to }) => {
    const conversions: Record<string, Record<string, (v: number) => number>> = {
      km: { miles: (v) => v * 0.621371 },
      miles: { km: (v) => v * 1.60934 },
      C: { F: (v) => (v * 9) / 5 + 32 },
      F: { C: (v) => ((v - 32) * 5) / 9 },
    };
    return { result: conversions[from]?.[to]?.(value) ?? "Conversion non supportée" };
  }
);

// 2. Regrouper dans un Skill
const mathSkill = createSkill({
  name: "math",
  description: "Outils de calcul et conversion d'unités",
  tools: [calculTool, convertTool],
  systemPrompt: "Utilise les outils math_calculate et math_convert_units pour répondre aux questions numériques.",
  initialize: async () => console.log("✓ Math skill prêt"),
  shutdown: async () => console.log("✓ Math skill nettoyé"),
});

// 3. Attacher le skill à un agent
const agent = new Agent({
  name: "Assistant",
  model: "Qwen3.5-9B.gguf",
  skills: [mathSkill], // Les outils seront exposés comme "math_calculate" et "math_convert_units"
});

const response = await agent.run("Combien font 42 × 17, et convertis 100 km en miles ?");
console.log(response);
// → 42 × 17 = 714. 100 km ≈ 62.14 miles.

await agent.shutdown(); // Appelle automatiquement le hook shutdown du skill
```

### 6. Skills Dynamiques — Ajout et Suppression à Chaud

Les skills peuvent être ajoutés ou retirés à tout moment, même après l'initialisation de l'agent.

```typescript
import { Agent, createTool, createSkill } from "@thegetget/get-agent";
import { z } from "zod";

const timeTool = createTool(
  "current_time",
  "Retourne la date et l'heure actuelle.",
  z.object({}),
  () => ({ timestamp: new Date().toISOString() })
);

const timeSkill = createSkill({
  name: "time",
  description: "Utilitaires de date et heure",
  tools: [timeTool],
  prefixToolNames: false, // Désactive le préfixe → l'outil reste "current_time"
});

const agent = new Agent({
  name: "Assistant",
  model: "Qwen3.5-9B.gguf",
});

// Ajout dynamique
await agent.addSkill(timeSkill);
console.log(agent.getRegisteredSkills()); // [Skill { name: "time" }]
console.log(agent.getRegisteredTools());  // [Tool { name: "current_time" }]

// Utilisation
const response = await agent.run("Quelle heure est-il ?");
console.log(response);

// Suppression à chaud (appelle le hook shutdown du skill)
await agent.removeSkill("time");
console.log(agent.getRegisteredTools()); // [] — les outils du skill ont été retirés

await agent.shutdown();
```

### 7. Workflow Séquentiel

Le cas le plus simple : une chaîne linéaire d'étapes exécutées dans l'ordre, reliées par `addEdge`.

```typescript
import { Workflow } from "@thegetget/get-agent";

interface EtatPipeline {
  donneesBrutes: string;
  donneesNettoyees: string;
  rapport: string;
}

const pipeline = new Workflow<EtatPipeline>({
  name: "Pipeline ETL",
  verbose: true,
});

pipeline
  .addStep("extraire", async (state) => {
    // Extraction des données depuis une source
    return { donneesBrutes: "ligne1;ligne2;ligne3" };
  })
  .addStep("transformer", async (state) => {
    // Nettoyage et transformation
    const nettoyees = state.donneesBrutes.split(";").map(s => s.trim()).join(", ");
    return { donneesNettoyees: nettoyees };
  })
  .addStep("charger", async (state) => {
    // Génération du rapport final
    return { rapport: `Données chargées : ${state.donneesNettoyees}` };
  });

// Chaîne linéaire : extraire -> transformer -> charger -> END
pipeline
  .setStart("extraire")
  .addEdge("extraire", "transformer")
  .addEdge("transformer", "charger")
  .addEdge("charger", "END");

const resultat = await pipeline.run({
  donneesBrutes: "",
  donneesNettoyees: "",
  rapport: "",
});

console.log(resultat.rapport);
```

### 8. Workflow Conditionnel

Utilisation de `addConditionalEdge` pour créer des branchements dynamiques basés sur l'état courant.

```typescript
import { Workflow } from "@thegetget/get-agent";

interface EtatCommande {
  commandeId: string;
  panierValide: boolean;
  stockDisponible: boolean;
  status: string;
}

const workflow = new Workflow<EtatCommande>({
  name: "Traitement Commande",
  verbose: true,
});

workflow
  .addStep("verifierPanier", async (state) => {
    return { panierValide: true };
  })
  .addStep("verifierStock", async (state) => {
    return { stockDisponible: true };
  })
  .addStep("confirmerCommande", async (state) => {
    return { status: "CONFIRMÉE" };
  })
  .addStep("annulerCommande", async (state) => {
    return { status: "ANNULÉE" };
  });

workflow
  .setStart("verifierPanier")
  // Branchement : panier valide -> vérifier stock, sinon -> annuler
  .addConditionalEdge("verifierPanier", (state) => {
    return state.panierValide ? "verifierStock" : "annulerCommande";
  })
  // Branchement : stock disponible -> confirmer, sinon -> annuler
  .addConditionalEdge("verifierStock", (state) => {
    return state.stockDisponible ? "confirmerCommande" : "annulerCommande";
  })
  .addEdge("confirmerCommande", "END")
  .addEdge("annulerCommande", "END");

const etatFinal = await workflow.run({
  commandeId: "CMD-9876",
  panierValide: false,
  stockDisponible: false,
  status: "INITIE"
});

console.log("Statut final :", etatFinal.status);
```
### 9. Workflow avec Agent IA

Intégration d'un `Agent` au sein des étapes d'un workflow pour déléguer des tâches de raisonnement au LLM.

```typescript
import { Workflow, Agent } from "@thegetget/get-agent";

interface EtatAnalyse {
  texteOriginal: string;
  resume: string;
  sentiment: string;
  traduction: string;
}

// Un seul agent polyvalent utilisé à chaque étape
const agent = new Agent({
  name: "Analyste",
  systemPrompt: "Tu es un assistant d'analyse de texte. Réponds de manière concise.",
  model: "Qwen3.5-9B.gguf",
});

const pipeline = new Workflow<EtatAnalyse>({
  name: "Analyse de Texte",
  verbose: true,
});

pipeline
  .addStep("resumer", async (state) => {
    const response = await agent.run(
      `Résume le texte suivant en 2 phrases maximum :\n${state.texteOriginal}`
    );
    return { resume: String(response) };
  })
  .addStep("analyserSentiment", async (state) => {
    const response = await agent.run(
      `Quel est le sentiment général (positif, négatif ou neutre) de ce texte ?\n${state.resume}`
    );
    return { sentiment: String(response) };
  })
  .addStep("traduire", async (state) => {
    const response = await agent.run(
      `Traduis ce résumé en anglais :\n${state.resume}`
    );
    return { traduction: String(response) };
  });

pipeline
  .setStart("resumer")
  .addEdge("resumer", "analyserSentiment")
  .addEdge("analyserSentiment", "traduire")
  .addEdge("traduire", "END");

const resultat = await pipeline.run({
  texteOriginal: "L'intelligence artificielle transforme tous les secteurs. Les entreprises adoptent massivement ces technologies pour améliorer leur productivité et innover.",
  resume: "",
  sentiment: "",
  traduction: "",
});

console.log("Résumé :", resultat.resume);
console.log("Sentiment :", resultat.sentiment);
console.log("Traduction :", resultat.traduction);
```

### 10. Workflow Multi-Agents (Boucle de feedback)

Plusieurs agents autonomes coopèrent au sein d'un workflow avec une boucle de correction automatique.

```typescript
import { Workflow, Agent } from "@thegetget/get-agent";

interface BlogState {
  sujet: string;
  draft: string;
  feedback: string;
  approuve: boolean;
}

const redacteur = new Agent({
  name: "Redacteur",
  systemPrompt: "Rédige des articles clairs et informatifs.",
  model: "Qwen3.5-9B.gguf"
});

const correcteur = new Agent({
  name: "Correcteur",
  systemPrompt: "Recherche les faiblesses. Réponds par 'OK' si le texte est parfait, sinon donne des axes d'amélioration.",
  model: "Qwen3.5-9B.gguf"
});

const workflow = new Workflow<BlogState>({
  name: "Redaction Article",
  verbose: true,
});

workflow
  .addStep("rediger", async (state) => {
    const prompt = `Rédige un article sur : ${state.sujet}.\nFeedback précédent : ${state.feedback}`;
    const response = await redacteur.run(prompt);
    return { draft: typeof response === "string" ? response : JSON.stringify(response) };
  })
  .addStep("reviser", async (state) => {
    const prompt = `Valide l'article suivant :\n${state.draft}`;
    const response = await correcteur.run(prompt);
    const feedback = typeof response === "string" ? response : JSON.stringify(response);
    return {
      feedback,
      approuve: feedback.toUpperCase().includes("OK")
    };
  });

workflow
  .setStart("rediger")
  .addEdge("rediger", "reviser")
  // Boucle : si rejeté, retour à la rédaction avec le feedback
  .addConditionalEdge("reviser", (state) => {
    return state.approuve ? "END" : "rediger";
  });

const etatFinal = await workflow.run({
  sujet: "Les avantages du protocole MCP pour les agents IA",
  draft: "",
  feedback: "",
  approuve: false
});

console.log("Article validé et publié !\n", etatFinal.draft);
```

### 11. Streaming (Réponse en Temps Réel)

`agent.runStream()` renvoie un `AsyncGenerator` qui diffuse la réponse finale token par token. Les appels d'outils sont gérés en interne et de façon transparente : seul le texte final est émis.

```typescript
import { Agent } from "@thegetget/get-agent";

const agent = new Agent({
  name: "Conteur",
  systemPrompt: "Tu es un conteur captivant.",
  model: "Qwen3.5-9B.gguf",
  showThinking: false, // Masque les blocs <think> du flux
});

// Itère sur les fragments au fur et à mesure de leur génération
for await (const chunk of agent.runStream("Raconte une courte histoire sur un robot curieux.")) {
  process.stdout.write(chunk);
}
```

### 12. Streaming + Sortie Structurée

`runStreamStructured()` combine le streaming et la validation Zod : on itère le `stream` pour l'affichage temps réel, et on `await` le `result` pour récupérer l'objet typé et validé.

```typescript
import { Agent } from "@thegetget/get-agent";
import { z } from "zod";

const agent = new Agent({ name: "Extracteur", model: "Qwen3.5-9B.gguf" });

const schema = z.object({
  titre: z.string(),
  motsCles: z.array(z.string()),
});

const { stream, result } = agent.runStreamStructured(
  "Génère un titre et des mots-clés pour un article sur les agents IA.",
  { schema, maxRetries: 2 }
);

// Affichage temps réel
for await (const chunk of stream) {
  process.stdout.write(chunk);
}

// Objet final validé
const data = await result;
console.log("\n\nObjet validé :", data);
```

### 13. REPL Interactif

`agent.repl()` lance une boucle interactive dans le terminal. Commandes intégrées : `/exit`, `/clear`, `/usage`, `/tools`, `/help`.

```typescript
import { Agent } from "@thegetget/get-agent";

const agent = new Agent({
  name: "mon-agent",
  systemPrompt: "Tu es un assistant utile.",
  model: "Qwen3.5-9B.gguf",
});

// stream: true pour afficher les réponses en temps réel
await agent.repl({ stream: true, prompt: "Vous" });
```

### 14. Hooks / Middleware

Les **hooks** permettent d'observer et d'intercepter le cycle de vie de l'agent. Tous sont optionnels et peuvent être asynchrones.

| Hook | Signature | Effet du retour |
| --- | --- | --- |
| `beforeLLMCall` | `(messages) => Message[] \| void` | Remplace les messages envoyés au LLM (ou `void` pour les garder). |
| `afterLLMCall` | `(content, toolCalls?) => void` | Observation uniquement (audit, logs). |
| `beforeToolCall` | `(toolName, args) => any \| false` | `false` annule l'appel ; un objet remplace les arguments ; `void`/`true` poursuit. |
| `afterToolCall` | `(toolName, args, result) => any` | Une valeur retournée remplace le résultat de l'outil. |

```typescript
import { Agent, createTool, AgentHooks } from "@thegetget/get-agent";
import { z } from "zod";

const weatherTool = createTool(
  "get_weather",
  "Retourne la météo simulée pour une ville.",
  z.object({ city: z.string() }),
  async ({ city }) => ({ city, temperature: 21, condition: "Ensoleillé" })
);

const hooks: AgentHooks = {
  beforeLLMCall: (messages) => {
    console.log(`[hook] ${messages.length} messages envoyés au LLM`);
    return messages;
  },
  afterLLMCall: (content, toolCalls) => {
    if (toolCalls?.length) console.log(`[hook] outils demandés : ${toolCalls.map(t => t.function.name).join(", ")}`);
  },
  beforeToolCall: (toolName, args) => {
    // Normalise / valide les arguments avant exécution
    if (toolName === "get_weather") args.city = args.city.trim();
    return args;
  },
  afterToolCall: (toolName, _args, result) => {
    // Enrichit le résultat retourné au LLM
    return { ...result, source: "weather-api" };
  },
};

const agent = new Agent({
  name: "hooked-agent",
  model: "Qwen3.5-9B.gguf",
  tools: [weatherTool],
  hooks,
});

console.log(await agent.run("Quelle est la météo à Paris ?"));
```

### 15. Human-in-the-Loop (Approbation d'Outils)

Marquez un outil comme sensible avec `requiresApproval = true`. Avant son exécution, l'agent appelle le callback `onApprovalRequired` : retournez `true` pour autoriser, `false` pour annuler.

```typescript
import { Agent, createTool } from "@thegetget/get-agent";
import { z } from "zod";

const deleteFileTool = createTool(
  "delete_file",
  "Supprime définitivement un fichier.",
  z.object({ path: z.string() }),
  async ({ path }) => ({ success: true, deleted: path })
);

// Marque l'outil comme nécessitant une approbation humaine
deleteFileTool.requiresApproval = true;

const agent = new Agent({
  name: "file-manager",
  systemPrompt: "Tu aides à gérer des fichiers.",
  model: "Qwen3.5-9B.gguf",
  tools: [deleteFileTool],

  // Appelé juste avant l'exécution de tout outil avec requiresApproval = true
  onApprovalRequired: async (toolName, args) => {
    console.log(`Approbation requise : ${toolName}(${JSON.stringify(args)})`);
    // Ici : demander une confirmation (readline, UI, webhook...). On simule un refus.
    return false;
  },
});

const response = await agent.run("Supprime le fichier /data/backup.sql.");
console.log(response); // L'agent reçoit { cancelled: true } et adapte sa réponse
```

### 16. Agent comme Outil (Sous-Agents)

`createAgentTool` encapsule un `Agent` en tant qu'outil, permettant à un agent « orchestrateur » de déléguer des tâches à des agents spécialisés.

```typescript
import { Agent, createAgentTool } from "@thegetget/get-agent";

// Agent spécialisé
const traducteur = new Agent({
  name: "Traducteur",
  systemPrompt: "Tu traduis fidèlement vers l'anglais. Réponds uniquement avec la traduction.",
  model: "Qwen3.5-9B.gguf",
});

// On l'expose comme un outil
const traducteurTool = createAgentTool(traducteur, {
  name: "traduire_en_anglais",
  description: "Traduit un texte français vers l'anglais.",
  keepHistory: false, // Réinitialise l'historique du sous-agent à chaque appel (défaut)
});

// Agent orchestrateur
const assistant = new Agent({
  name: "Assistant",
  systemPrompt: "Tu es un assistant. Utilise tes outils quand c'est pertinent.",
  model: "Qwen3.5-9B.gguf",
  tools: [traducteurTool],
});

console.log(await assistant.run("Traduis 'Bonjour le monde' en anglais."));
```

### 17. Budget & Suivi de Consommation

Limitez la consommation par session (tokens ou coût USD) et consultez l'usage cumulé. Si une limite est franchie, `run()` lève une erreur.

```typescript
import { Agent } from "@thegetget/get-agent";

const agent = new Agent({
  name: "Assistant",
  model: "Qwen3.5-9B.gguf",
  budget: {
    maxTokens: 100_000,   // Plafond de tokens pour la session
    maxCostUSD: 0.50,     // Plafond de coût (nécessite pricing)
    pricing: {
      inputPerMToken: 0.15,   // Prix par million de tokens d'entrée
      outputPerMToken: 0.60,  // Prix par million de tokens de sortie
    },
  },
});

await agent.run("Explique le protocole MCP en une phrase.");

// Récupère la consommation cumulée + coût estimé
const usage = agent.getUsage();
console.log(usage);
// { totalPromptTokens, totalCompletionTokens, totalTokens, llmCallCount, estimatedCostUSD }

agent.clearUsage(); // Réinitialise les compteurs
```

### 18. Guardrails (Filtres d'Entrée / Sortie)

Les **guardrails** filtrent l'entrée utilisateur avant le LLM et/ou la réponse finale avant qu'elle soit renvoyée. Un guardrail peut **bloquer** (lève une erreur) ou **assainir** (transforme le texte). Helpers fournis : `maxLength`, `blockedPatterns`, `sanitize`, `redactPII`.

```typescript
import { Agent, maxLength, blockedPatterns, redactPII, sanitize } from "@thegetget/get-agent";

const agent = new Agent({
  name: "Assistant",
  model: "Qwen3.5-9B.gguf",
  guardrails: {
    input: [
      maxLength(2000),                          // Bloque les entrées trop longues
      blockedPatterns([/mot-interdit/i]),       // Bloque certains motifs
      redactPII(),                              // Masque emails / téléphones / cartes
    ],
    output: [
      sanitize((t) => t.replace(/\bAPI_KEY=\S+/g, "API_KEY=[REDACTED]")), // Nettoie la sortie
    ],
  },
});

// Une entrée bloquée lève une erreur ; une entrée assainie est transformée silencieusement.
console.log(await agent.run("Contacte-moi à jean.dupont@example.com"));
```

### 19. Persistance de l'Historique

Avec un `historyAdapter` et un `sessionId`, l'agent charge l'historique au démarrage et le sauvegarde après chaque `run()` — idéal pour des conversations reprises entre exécutions. `FileHistoryAdapter` stocke un fichier JSON par session.

```typescript
import { Agent, FileHistoryAdapter } from "@thegetget/get-agent";

const agent = new Agent({
  name: "Assistant",
  model: "Qwen3.5-9B.gguf",
  historyAdapter: new FileHistoryAdapter(".agent-history"), // <dir>/<sessionId>.json
  sessionId: "user-42",
});

// Premier lancement
await agent.run("Je m'appelle Gaëtan.");

// Lors d'une exécution ultérieure (même sessionId), l'agent se souvient du contexte
const response = await agent.run("Quel est mon prénom ?");
console.log(response); // → "Gaëtan"
```

> Vous pouvez implémenter l'interface `HistoryAdapter` (`load`, `save`, `clear`) pour persister vers une base de données ou un cache.

### 20. Logger Structuré

Configurez la journalisation avec des niveaux (`debug`, `info`, `warn`, `error`), un format `text` ou `json`, ou un transport personnalisé (envoi vers un service de logs). La config `logger` prend le pas sur `verbose`.

```typescript
import { Agent } from "@thegetget/get-agent";

const agent = new Agent({
  name: "Assistant",
  model: "Qwen3.5-9B.gguf",
  logger: {
    level: "debug",
    format: "json", // Logs structurés JSON, parfaits pour l'agrégation
    // transport: (entry) => myLogService.send(entry), // Transport sur mesure (override le format)
  },
});

await agent.run("Bonjour !");
```

### 21. Retries & Exécution Parallèle des Outils

GetAgent réessaie automatiquement les appels LLM en échec (backoff exponentiel) et peut exécuter en parallèle plusieurs outils demandés dans une même itération.

```typescript
import { Agent } from "@thegetget/get-agent";

const agent = new Agent({
  name: "Assistant",
  model: "Qwen3.5-9B.gguf",
  parallelTools: true, // Exécute en parallèle les appels d'outils indépendants
  retry: {
    maxRetries: 3,                                 // Tentatives après l'échec initial
    initialDelayMs: 500,                           // Délai initial avant le 1er retry
    maxDelayMs: 10_000,                            // Délai max entre deux retries
    retryableStatuses: [429, 500, 502, 503, 504],  // Codes HTTP déclenchant un retry
  },
});

console.log(await agent.run("Compare la météo de Paris et de Lyon."));
```

---

## Référence de Configuration (`AgentConfig`)

| Option | Type | Défaut | Description |
| --- | --- | --- | --- |
| `name` | `string` | — (requis) | Nom de l'agent. |
| `systemPrompt` | `string` | `"You are a helpful AI assistant."` | Prompt système de base. |
| `model` | `string` | `"Qwen3.5-9B.gguf"` | Nom du modèle. |
| `baseUrl` | `string` | URL interne par défaut | URL de l'API compatible OpenAI. |
| `apiKey` | `string` | `"no-key"` | Clé API (facultative pour un backend local). |
| `tools` | `Tool[]` | `[]` | Outils locaux exposés à l'agent. |
| `skills` | `Skill[]` | `[]` | Skills attachés à l'agent. |
| `mcpServers` | `McpServerConfig[]` | `[]` | Serveurs MCP à connecter (stdio). |
| `maxIterations` | `number` | `10` | Nombre max d'itérations de la boucle agent. |
| `temperature` | `number` | `0.2` | Température d'échantillonnage. |
| `showThinking` | `boolean` | `true` | Affiche/conserve les blocs `<think>`. |
| `hooks` | `AgentHooks` | `{}` | Hooks de cycle de vie (voir §14). |
| `onApprovalRequired` | `(toolName, args) => Promise<boolean>` | — | Callback d'approbation (voir §15). |
| `budget` | `BudgetConfig` | — | Plafonds de tokens/coût et pricing (voir §17). |
| `guardrails` | `Guardrails` | — | Filtres d'entrée/sortie (voir §18). |
| `historyAdapter` | `HistoryAdapter` | — | Persistance de l'historique (voir §19). |
| `sessionId` | `string` | — | Identifiant de session (requis avec `historyAdapter`). |
| `logger` | `LoggerConfig` | — | Journalisation structurée (voir §20). |
| `retry` | `RetryConfig` | voir §21 | Stratégie de retry des appels LLM. |
| `parallelTools` | `boolean` | `false` | Exécution parallèle des outils. |
| `verbose` | `boolean` | `false` | Logs de debug sur la console. |

### Principales méthodes de `Agent`

| Méthode | Description |
| --- | --- |
| `run(input, structuredConfig?)` | Exécute la boucle agent ; renvoie un texte ou un objet validé. |
| `runStream(input)` | Diffuse la réponse finale token par token (`AsyncGenerator`). |
| `runStreamStructured(input, config)` | `{ stream, result }` : flux + objet validé. |
| `repl(options?)` | Lance une session interactive en terminal. |
| `addSkill(skill)` / `removeSkill(name)` | Gestion dynamique des skills. |
| `getRegisteredTools()` / `getRegisteredSkills()` | Inspection des capacités enregistrées. |
| `getHistory()` / `clearHistory()` | Lecture / réinitialisation de l'historique. |
| `getUsage()` / `clearUsage()` | Suivi / réinitialisation de la consommation. |
| `initialize()` / `shutdown()` | Connexion / nettoyage (MCP, skills). |

---

## Licence

Ce projet est sous licence ISC.
