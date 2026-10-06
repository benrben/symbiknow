import { configDefaults, defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.js';

const nativePersistenceTests = [
  'server/jev/runtime-admission-drain.native.test.ts',
  'server/jev/runtime-scheduler.native.test.ts',
  'src/research-edits.public.test.tsx',
];

export default mergeConfig(viteConfig, defineConfig({
  test: {
    // Native ONNX Runtime can crash V8 during worker isolate teardown; use process isolation.
    pool: 'forks',
    projects: [
      {
        extends: true,
        test: {
          name: 'native-persistence',
          include: nativePersistenceTests,
          // Measure canonical writes and queue scenarios without competing test workers.
          fileParallelism: false,
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: 'suite',
          exclude: [...configDefaults.exclude, ...nativePersistenceTests],
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
}));
