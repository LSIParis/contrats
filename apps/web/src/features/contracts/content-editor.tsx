import { useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';

export function ContentEditor({
  initialHtml, saving, onSave, onPreview,
}: {
  initialHtml: string;
  saving: boolean;
  onSave: (html: string) => void;
  onPreview: () => void;
}) {
  // L'état suit le HTML ; initialisé à initialHtml, mis à jour à chaque frappe.
  // « Enregistrer » envoie cet état — pas besoin d'interroger l'éditeur au clic.
  const [html, setHtml] = useState(initialHtml);
  const editor = useEditor({
    extensions: [StarterKit],
    content: initialHtml,
    onUpdate: ({ editor }) => setHtml(editor.getHTML()),
  });

  const tb = 'rounded border px-2 py-1 text-sm hover:bg-gray-100';
  return (
    <div className="space-y-3">
      <div className="flex gap-1">
        <button type="button" className={tb} onClick={() => editor?.chain().focus().toggleBold().run()}><b>G</b></button>
        <button type="button" className={tb} onClick={() => editor?.chain().focus().toggleItalic().run()}><i>I</i></button>
        <button type="button" className={tb} onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}>Titre</button>
        <button type="button" className={tb} onClick={() => editor?.chain().focus().toggleBulletList().run()}>• Liste</button>
      </div>
      <div className="rounded border p-3 min-h-[240px] prose max-w-none">
        <EditorContent editor={editor} />
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => onSave(html)}
          disabled={saving}
          className="rounded bg-lsi px-4 py-2 text-white hover:bg-lsi-dark disabled:opacity-50"
        >
          {saving ? 'Enregistrement…' : 'Enregistrer'}
        </button>
        <button type="button" onClick={onPreview} className="rounded border px-4 py-2 text-sm">Aperçu PDF</button>
      </div>
    </div>
  );
}
