---
name: message-de-commit
description: Rédige des messages de commit Git au format Conventional Commits à partir d'une description de changements. À utiliser dès qu'on demande un message de commit.
license: ISC
metadata:
  author: getagent-examples
  version: "1.0"
---

# Message de commit

1. Identifie le **type** du changement :
   `feat` (fonctionnalité), `fix` (correction), `refactor`, `docs`, `test`, `chore`, `perf`.
2. Choisis une **portée** courte entre parenthèses si le changement concerne un module précis (`feat(auth): …`).
3. Écris le **sujet** à l'impératif, en anglais, en 72 caractères maximum, sans point final.
4. Si le changement n'est pas trivial, ajoute un **corps** après une ligne vide : le *pourquoi*, pas le *comment*.
5. Pour un changement incompatible, ajoute `!` après le type et une ligne `BREAKING CHANGE: …` dans le pied.

Consulte `references/exemples.md` pour des exemples avant de répondre.

Réponds uniquement avec le message de commit, dans un bloc de code.
