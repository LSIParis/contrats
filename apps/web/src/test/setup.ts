import '@testing-library/jest-dom/vitest';

// jsdom implémente désormais createObjectURL : usePdfObjectUrl tenterait un vrai
// fetch au lieu de son repli sur l'URL directe, celui que les tests vérifient.
delete (URL as { createObjectURL?: unknown }).createObjectURL;
