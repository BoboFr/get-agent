/**
 * GetAgent — 14 · Multimodal (images & documents)
 *
 * Comment envoyer des images et des documents à un modèle vision/multimodal
 * via le format de "content parts" compatible OpenAI.
 *
 * Lancer :  npx tsx examples/14_multimodal.ts
 */
import {
  Agent,
  userMessage,
  imageFromUrl,
  imageFromFile,
  fileFromPath,
  imageFromBase64
} from "../src/index.js";

import { z } from "zod"

const ouputSchema = z.object({
  hairColor: z.string(),
  eyeColor: z.string(),
  skinColor: z.string(),
  sex: z.enum(["male", "female"])
});

async function main() {
  console.log("══ 14 · Multimodal ══\n");

  const agent = new Agent({
    name: "AssistantVision",
    systemPrompt: "Tu décris précisément les images et documents fournis.",
    // Utilisez un modèle multimodal côté backend (ex : Qwen2.5-VL, llava…) :
    // model: "Qwen2.5-VL-7B.gguf",
    // baseUrl: "http://localhost:8080/v1",
  });

  // ── 1. Image distante (URL) ──────────────────────────────────────────────
  console.log("» Image par URL :");
  const r1 = await agent.run([
    userMessage(
      "Que vois-tu sur cette image ?",
      await imageFromFile("./18.jpg")
    ),
  ], {
    schema: ouputSchema,
  });
  console.log(r1, "\n");

  agent.clearHistory();

  void imageFromFile;
  void fileFromPath;

  await agent.shutdown();
  console.log("✅ Terminé.");
}

main().catch(console.error);
