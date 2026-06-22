/**
 * GetAgent — 03 · Skills (modules réutilisables)
 *
 * Un Skill regroupe des outils, un prompt système et des hooks de cycle de vie.
 * Démontre : skill statique, préfixage des outils, ajout/suppression à chaud.
 *
 * Lancer :  npx tsx examples/03_skills.ts
 */
import { z } from "zod";
import { Agent, createTool, createSkill } from "../src/index.js";

// ── Outils du skill « finance » ─────────────────────────────────────────────
const tva = createTool(
  "tva",
  "Calcule le prix TTC à partir d'un prix HT.",
  z.object({ ht: z.number(), taux: z.number().default(20) }),
  ({ ht, taux }) => ({ ttc: Number((ht * (1 + taux / 100)).toFixed(2)), taux })
);

const remise = createTool(
  "remise",
  "Applique un pourcentage de remise à un prix.",
  z.object({ prix: z.number(), pourcent: z.number() }),
  ({ prix, pourcent }) => ({ prixRemise: Number((prix * (1 - pourcent / 100)).toFixed(2)) })
);

// ── Outil du skill « horloge » ──────────────────────────────────────────────
const maintenant = createTool(
  "maintenant",
  "Retourne la date et l'heure courantes au format ISO.",
  z.object({}),
  () => ({ iso: new Date().toISOString() })
);

// ── Définition des skills ───────────────────────────────────────────────────
const financeSkill = createSkill({
  name: "finance",
  description: "Calculs commerciaux : TVA et remises",
  tools: [tva, remise],
  // Préfixe activé par défaut → outils exposés : finance_tva, finance_remise
  systemPrompt: "Pour tout calcul de prix, utilise finance_tva et finance_remise.",
  initialize: async () => console.log("  ✓ skill finance prêt"),
  shutdown: async () => console.log("  ✓ skill finance arrêté"),
});

const horlogeSkill = createSkill({
  name: "horloge",
  description: "Utilitaires de date et heure",
  tools: [maintenant],
  prefixToolNames: false, // l'outil garde son nom d'origine : maintenant
});

async function main() {
  console.log("══ 03 · Skills ══\n");

  const agent = new Agent({
    name: "AssistantSkills",
    systemPrompt: "Tu es un assistant équipé de compétences spécialisées.",
    skills: [financeSkill],
    verbose: true,
  });

  console.log("Outils au démarrage :", agent.getRegisteredTools().map((t) => t.name));

  // ── Ajout dynamique d'un skill ──
  await agent.addSkill(horlogeSkill);
  console.log("Après ajout d'horloge :", agent.getRegisteredTools().map((t) => t.name));

  const r1 = await agent.run("Un article coûte 80€ HT. Quel est son prix TTC à 20% ?");
  console.log("\n💬", r1);

  // ── Suppression à chaud (déclenche le hook shutdown du skill) ──
  await agent.removeSkill("finance");
  console.log("\nAprès retrait de finance :", agent.getRegisteredTools().map((t) => t.name));

  await agent.shutdown();
  console.log("\n✅ Terminé.");
}

main().catch(console.error);
