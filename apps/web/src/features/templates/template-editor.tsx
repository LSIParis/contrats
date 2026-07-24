import { useEffect } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';

interface Props {
  initialHtml: string;
  onChange: (html: string) => void;
  onEmptyChange?: (empty: boolean) => void;
  /** Recharge le contenu de l'éditeur quand `nonce` change (ex. brouillon IA). */
  inject?: { html: string; nonce: number };
}

export function TemplateEditor({ initialHtml, onChange, onEmptyChange, inject }: Props) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        horizontalRule: false,
        codeBlock: false,
        code: false,
      }),
    ],
    content: initialHtml,
    onUpdate: ({ editor }) => {
      onChange(editor.getHTML());
      onEmptyChange?.(editor.isEmpty);
    },
  });

  // Émet l'état initial une fois l'éditeur prêt (montage / remontage via `key`).
  // onChange/onEmptyChange volontairement hors deps : ce sont des closures
  // recréées à chaque render de la page ; les inclure re-déclencherait l'effet
  // en boucle. On veut une seule émission par instance d'éditeur.
  useEffect(() => {
    if (!editor) return;
    onChange(editor.getHTML());
    onEmptyChange?.(editor.isEmpty);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  // Injection d'un brouillon (ex. IA) : recharge le contenu quand nonce change.
  useEffect(() => {
    if (!editor || !inject) return;
    editor.commands.setContent(inject.html);
    onChange(editor.getHTML());
    onEmptyChange?.(editor.isEmpty);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inject?.nonce]);

  const tb = 'rounded border px-2 py-1 text-sm hover:bg-gray-100';
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        <button type="button" className={tb} onClick={() => editor?.chain().focus().toggleBold().run()}><b>G</b></button>
        <button type="button" className={tb} onClick={() => editor?.chain().focus().toggleItalic().run()}><i>I</i></button>
        <button type="button" className={tb} onClick={() => editor?.chain().focus().toggleStrike().run()}><s>S</s></button>
        <button type="button" className={tb} onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}>Titre</button>
        <button type="button" className={tb} onClick={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()}>Sous-titre</button>
        <button type="button" className={tb} onClick={() => editor?.chain().focus().toggleBulletList().run()}>• Liste</button>
        <button type="button" className={tb} onClick={() => editor?.chain().focus().toggleOrderedList().run()}>1. Liste</button>
        <button type="button" className={tb} onClick={() => editor?.chain().focus().toggleBlockquote().run()}>Citation</button>
      </div>
      <div className="rounded border p-3 min-h-[240px] prose max-w-none">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
