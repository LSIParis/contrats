import { render, screen } from '@testing-library/react';
import { App } from '../app.js';

test('la coquille rend le titre', () => {
  render(<App />);
  expect(screen.getByText('LSI Contrats')).toBeInTheDocument();
});
