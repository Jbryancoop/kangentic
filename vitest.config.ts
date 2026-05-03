import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `tests/unit/**` runs by default via `npm run test:unit`.
    // `tests/integration/**` is opt-in - tests there hit real CLIs / file
    // system / network and only make sense to run on demand. They are
    // excluded from `npm run test:unit` via the explicit unit-only path
    // in package.json (`vitest run tests/unit`), and are picked up here
    // when a developer runs `npx vitest run tests/integration/...`.
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
  },
});
