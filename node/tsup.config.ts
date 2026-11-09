import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'stores/redis': 'src/stores/redis.ts',
    'stores/postgres': 'src/stores/postgres.ts',
    agentisend: 'src/agentisend.ts',
    'policy-file': 'src/policy-file.ts',
    nodemailer: 'src/nodemailer.ts',
    'openai-agents': 'src/openai-agents.ts',
    cli: 'src/cli.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node18',
  splitting: true,
  treeshake: true,
});
