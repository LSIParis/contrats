import { describe, test, expect } from 'vitest';
import { slugifyFilename } from '../../src/documents/filename.js';

describe('slugifyFilename', () => {
  test('retire guillemets, retours à la ligne et caractères de contrôle', () => {
    const s = slugifyFilename('Maintenance "annuelle"\r\n préventive');
    expect(s).not.toMatch(/["\r\n]/);
    expect(s).toBe('Maintenance-annuelle-preventive');
  });
  test('translittère les accents en ASCII', () => {
    expect(slugifyFilename('Modèle Café')).toBe('Modele-Cafe');
  });
  test('chaîne vide → fallback', () => {
    expect(slugifyFilename('   ')).toBe('document');
    expect(slugifyFilename('***', 'modele')).toBe('modele');
  });
});
