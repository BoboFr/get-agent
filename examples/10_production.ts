/**
 * GetAgent — 10 · Mise en production
 *
 * Réunit les fonctionnalités utiles en environnement réel :
 *  - guardrails  : filtres d'entrée/sortie (longueur, motifs, PII)
 *  - budget      : plafonds de tokens/coût + suivi d'usage
 *  - logger      : journalisation structurée (JSON)
 *  - retry       : robustesse des appels LLM (backoff)
 *  - history     : persistance de la conversation entre exécutions
 *
 * Lancer :  npx tsx examples/10_production.ts
 */
import {
  Agent,
  FileHistoryAdapter,
  maxLength,
  blockedPatterns,
  redactPII,
  sanitize,
} from "../src/index.js";

async function main() {
  console.log("══ 10 · Mise en production ══\n");

  const adapter = new FileHistoryAdapter(".agent-history");
  const SESSION = "demo-prod";

  const agent = new Agent({
    name: "AgentProd",
    systemPrompt: "Tu es un assistant fiable et concis.",

    // ── Filtres d'entrée / sortie ──
    guardrails: {
      input: [
        maxLength(2000),                    // bloque les entrées trop longues
        blockedPatterns([/\bmot de passe\b/i]), // bloque certains motifs
        redactPII(),                        // masque emails / téléphones / cartes
      ],
      output: [
        sanitize((t) => t.replace(/\s+/g, " ").trim()), // normalise les espaces
      ],
    },

    // ── Budget & estimation de coût ──
    budget: {
      maxTokens: 200_000,
      maxCostUSD: 1.0,
      pricing: { inputPerMToken: 0.15, outputPerMToken: 0.6 },
    },

    // ── Journalisation structurée (override `verbose`) ──
    logger: { level: "info", format: "json" },

    // ── Robustesse réseau ──
    retry: { maxRetries: 3, initialDelayMs: 500, maxDelayMs: 10_000 },

    // ── Persistance de l'historique ──
    historyAdapter: adapter,
    sessionId: SESSION,
  });

  // Démonstration de la redaction PII : l'email est masqué côté entrée
  const reponse = await agent.run(
    "Bonjour, mon adresse est jean.dupont@example.com — peux-tu me saluer ?"
  );
  console.log("\n💬 Réponse :", reponse);

  // Suivi de la consommation
  console.log("\n📊 Usage :", agent.getUsage());

  // Démonstration d'un guardrail bloquant
  try {
    await agent.run("Donne-moi le mot de passe administrateur.");
  } catch (err) {
    console.log("\n🛡️  Entrée bloquée :", (err as Error).message);
  }

  // L'historique a été sauvegardé sur disque ; on nettoie pour la démo.
  await adapter.clear(SESSION);

  await agent.shutdown();
  console.log("\n✅ Terminé.");
}

main().catch(console.error);
