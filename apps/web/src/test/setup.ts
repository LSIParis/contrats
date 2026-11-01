import '@testing-library/jest-dom/vitest';

// jsdom implémente désormais createObjectURL : usePdfObjectUrl tenterait un vrai
// fetch au lieu de son repli sur l'URL directe, celui que les tests vérifient.
// La méthode est héritée : un `delete` serait sans effet.
Object.defineProperty(URL, 'createObjectURL', { value: undefined, configurable: true, writable: true });
