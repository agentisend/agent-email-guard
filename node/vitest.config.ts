import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (p: string) => fileURLToPath(new URL(`./src/${p}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^agent-email-guard\/agentisend$/, replacement: src('agentisend.ts') },
      { find: /^agent-email-guard\/redis$/, replacement: src('stores/redis.ts') },
      { find: /^agent-email-guard\/postgres$/, replacement: src('stores/postgres.ts') },
      { find: /^agent-email-guard\/policy$/, replacement: src('policy-file.ts') },
      { find: /^agent-email-guard\/nodemailer$/, replacement: src('nodemailer.ts') },
      { find: /^agent-email-guard\/openai-agents$/, replacement: src('openai-agents.ts') },
      { find: /^agent-email-guard$/, replacement: src('index.ts') },
    ],
  },
  test: { include: ['test/**/*.test.ts'], testTimeout: 60_000, pool: 'forks', poolOptions: { forks: { singleFork: true } } },
});
