import { useEffect } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';

/**
 * Éditeur riche (TipTap) d'un fragment HTML : clause ou annexe. Le HTML est
 * ASSAINI côté serveur à l'enregistrement (liste blanche, brief §4) : l'éditeur
 * n'a pas à le faire. La zone éditable porte un nom accessible.
 */
export function RichText({ label, value, onChange }: { label: string; value: string; onChange: (html: string) => void }) {
  const editor = useEditor({
    extensions: [StarterKit],
    content: value,
    editorProps: {
      attributes: {
        'aria-label': label,
        role: 'textbox',
        'aria-multiline': 'true',
        class: 'min-h-[140px] outline-none',
      },
    },
    onUpdate: ({ editor: e }) => onChange(e.getHTML()),
  });

  // Contenu remplacé de l'extérieur (suggestion IA reprise, annulation) : on resynchronise.
  useEffect(() => {
    if (editor && !editor.isFocused && editor.getHTML() !== value) editor.commands.setContent(value, false);
  }, [editor, value]);

  const tb = 'rounded border border-line-strong bg-surface px-2 py-1 text-xs text-ink hover:bg-slate-100';
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1" role="toolbar" aria-label={`Mise en forme — ${label}`}>
        <button type="button" className={tb} aria-label="Gras" onClick={() => editor?.chain().focus().toggleBold().run()}><b>G</b></button>
        <button type="button" className={tb} aria-label="Italique" onClick={() => editor?.chain().focus().toggleItalic().run()}><i>I</i></button>
        <button type="button" className={tb} onClick={() => editor?.chain().focus().toggleBulletList().run()}>• Liste</button>
        <button type="button" className={tb} onClick={() => editor?.chain().focus().toggleOrderedList().run()}>1. Liste</button>
      </div>
      <div className="prose max-w-none rounded border border-line-strong bg-surface px-3 py-2 text-sm">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
