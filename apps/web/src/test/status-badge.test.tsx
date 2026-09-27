import { render, screen } from '@testing-library/react';
import { StatusBadge } from '../ui/status-badge.js';
import { STATUS_STYLES, STATUS_TONES } from '../ui/theme/status.js';
import { CONTRACT_STATUS_CODES, contractStatusLabel } from '../lib/labels.js';
import { contrastRatio } from '../ui/theme/contrast.js';

describe('contraste AA (≥ 4,5:1) texte / fond de chaque badge de statut', () => {
  test.each(CONTRACT_STATUS_CODES.map((c) => [c]))('%s', (code) => {
    const tone = STATUS_TONES[STATUS_STYLES[code].tone];
    expect(contrastRatio(tone.fg, tone.bg)).toBeGreaterThanOrEqual(4.5);
  });
});

test('chaque statut a une icône propre (la couleur ne porte jamais seule le sens)', () => {
  const icons = CONTRACT_STATUS_CODES.map((c) => STATUS_STYLES[c].icon);
  expect(new Set(icons).size).toBe(CONTRACT_STATUS_CODES.length);
});

test('le badge affiche le libellé français et une icône décorative', () => {
  const { container } = render(<StatusBadge status="PENDING_SIGNATURE" />);
  expect(screen.getByText(contractStatusLabel('PENDING_SIGNATURE'))).toBeInTheDocument();
  const svg = container.querySelector('svg');
  expect(svg).not.toBeNull();
  expect(svg).toHaveAttribute('aria-hidden', 'true');
});

test('un statut inconnu affiche le code brut, sans icône', () => {
  const { container } = render(<StatusBadge status="WAT" />);
  expect(screen.getByText('WAT')).toBeInTheDocument();
  expect(container.querySelector('svg')).toBeNull();
});
