/**
 * GetAgent — 16 · Agent Skills (dossiers SKILL.md)
 *
 * Une Agent Skill est un dossier contenant un fichier SKILL.md (frontmatter YAML
 * + instructions Markdown) et, éventuellement, des fichiers annexes.
 * Format ouvert : https://agentskills.io
 *
 * Seuls le nom et la description de chaque skill sont placés dans le prompt
 * système. Le modèle charge les instructions complètes avec l'outil `load_skill`
 * quand la tâche le demande, puis lit les fichiers annexes avec `read_skill_file`.
 *
 * Skills fournies : examples/skills/message-de-commit, examples/skills/compte-rendu-reunion
 *
 * Lancer :  npx tsx examples/16_agent_skills.ts
 */
import { fileURLToPath } from "node:url";
import { Agent, type AgentHooks } from "../src/index.js";

const skillsDir = fileURLToPath(new URL("./skills", import.meta.url));

// Affiche les outils appelés, pour voir les skills se charger à la demande.
const hooks: AgentHooks = {
  beforeToolCall: (name, args) => {
    console.log(`  🔧 ${name}(${JSON.stringify(args)})`);
  },
};

const agent = new Agent({
  name: "AssistantSkills",
  systemPrompt: "Tu es un assistant pour une équipe de développement. Réponds en français.",
  agentSkills: [skillsDir], // un dossier de skills, un dossier de skill, ou des skills déjà chargées
  hooks,
});

async function main() {
  console.log("══ 16 · Agent Skills ══\n");

  await agent.initialize();
  console.log("Skills disponibles :");
  for (const skill of agent.getAgentSkills()) {
    console.log(`  • ${skill.name} — ${skill.description.slice(0, 70)}…`);
  }

  console.log("\n▶ Demande 1 : message de commit");
  const commit = await agent.run(
    "J'ai ajouté un bouton « Mot de passe oublié » sur la page de connexion, qui envoie un e-mail de réinitialisation. Propose un message de commit."
  );
  console.log(`\n💬 ${commit}`);

  agent.clearHistory();
  console.log("\n▶ Demande 2 : compte rendu");
  const compteRendu = await agent.run(
    "Notes : réunion sprint 14. On garde la date de release au 30. Marc s'occupe de la migration BDD d'ici jeudi. " +
      "Question sur le budget des serveurs, à revoir avec la direction. Léa met à jour la doc."
  );
  console.log(`\n💬 ${compteRendu}`);

  await agent.shutdown();
  console.log("\n✅ Terminé.");
}

main().catch(console.error);
