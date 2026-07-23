import { useState } from 'react';
import { Button } from '../../ui/button.js';

interface Props {
  generating: boolean;
  error?: string;
  onGenerate: (input: { prompt: string; context?: string }) => void;
}

export function AiDraftPanel({ generating, error, onGenerate }: Props) {
  const [prompt, setPrompt] = useState('');
  const [context, setContext] = useState('');
  return (
    <div className="space-y-3 rounded border border-blue-200 bg-blue-50/40 p-3">
      <p className="text-sm text-amber-700">
        ⚠️ Brouillon généré par IA — à faire valider par un juriste avant publication.
      </p>
      <textarea
        className="w-full min-h-[80px] rounded border p-2 text-sm"
        placeholder="Décris le contrat souhaité (type, parties, durée, obligations…)"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
      />
      <textarea
        className="w-full min-h-[48px] rounded border p-2 text-sm"
        placeholder="Contexte additionnel (optionnel)"
        value={context}
        onChange={(e) => setContext(e.target.value)}
      />
      <Button
        onClick={() => onGenerate({ prompt, context: context.trim() || undefined })}
        disabled={generating || prompt.trim().length === 0}
      >
        {generating ? 'Génération…' : 'Générer'}
      </Button>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
