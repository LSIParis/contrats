/**
 * Options communes de `StarterKit` : Tiptap 3 y a ajouté des extensions qui
 * changeraient le HTML enregistré (liens et soulignement conservés, paragraphe
 * vide ajouté après un titre). Le contenu des contrats doit rester identique.
 */
export const editorKit = { link: false, underline: false, trailingNode: false } as const;
