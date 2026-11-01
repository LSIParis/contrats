import { describe, expect, test } from 'vitest';
import { Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { editorKit } from '../ui/editor-kit';

function roundTrip(html: string): string {
  const editor = new Editor({ extensions: [StarterKit.configure(editorKit)], content: html });
  const out = editor.getHTML();
  editor.destroy();
  return out;
}

describe('editorKit : le HTML des contrats ne change pas avec Tiptap 3', () => {
  test('pas de paragraphe ajouté après un titre', () => {
    expect(roundTrip('<h2>Article 1</h2>')).toBe('<h2>Article 1</h2>');
  });

  test('liens et soulignement restent retirés', () => {
    expect(roundTrip('<p><a href="https://exemple.fr">lien</a> <u>souligné</u></p>')).toBe('<p>lien souligné</p>');
  });

  test('gras, italique et listes sont conservés', () => {
    const html = '<p><strong>a</strong> <em>b</em></p><ul><li><p>c</p></li></ul>';
    expect(roundTrip(html)).toBe(html);
  });
});
