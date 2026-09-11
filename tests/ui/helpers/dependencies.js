// Reuse the UI's locked installation without a second package tree or symlinks.
import { createRequire } from 'node:module';

export const uiRequire = createRequire(new URL('../../../ui/package.json', import.meta.url));
export const { chromium, _electron } = uiRequire('playwright');
export const { expect } = uiRequire('playwright/test');
export const kit = uiRequire('terminal-kit');