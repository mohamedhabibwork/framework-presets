import { describe, expect, test } from 'bun:test';
import { defineProvider } from '@framework/core';
import { defineApp, MiddlewareRegistry } from '@framework/http';
import type { Operation } from '@framework/openapi';
import type { ApiPresetConfig } from '../src';
import { apiProject } from '../src/cli';

const config: ApiPresetConfig = {
  app: { name: 'project-test', env: 'test' },
  database: { url: 'postgres://app:unused@127.0.0.1:1/unused', maxConnections: 1 },
  redis: { url: 'redis://127.0.0.1:1' },
  queue: { name: 'jobs', prefix: 'project-test' },
  events: { driver: 'memory' },
  cache: { driver: 'memory' },
  logging: { level: 'info', driver: 'memory', name: 'project-test' },
  storage: { default: 'local', disks: { local: { driver: 'local', root: 'storage', visibility: 'private' } } },
  mail: { driver: 'memory', from: 'no-reply@project.test' },
  notifications: {},
};

const app = defineApp<ApiPresetConfig, Operation>({
  http: () => ({ exposeInternalErrors: false }),
  providers: [defineProvider<ApiPresetConfig>({ name: 'probe', register: () => {} })],
});

const options = {
  name: 'project-test',
  frameworkVersion: '0.0.0',
  root: '/srv/app',
  app,
  loadConfig: async () => config,
  createMiddleware: () => new MiddlewareRegistry(),
  buildOpenApiDocument: () => ({ openapi: '3.1.0' }),
};

describe('apiProject', () => {
  test('fills the conventional layout, tools and config hooks', async () => {
    const project = await apiProject(options);

    expect(project.paths).toMatchObject({
      app: 'bootstrap/app.ts',
      providers: 'bootstrap/app.ts',
      modules: 'app/modules',
    });
    expect(project.tools.worker).toEqual(['bun', 'run', 'bin/worker.ts']);
    expect(project.apiPrefix).toBe('/api/v1');
    expect(project.databaseUrl(config)).toBe(config.database.url);
    expect(project.queueUrl?.(config)).toEqual({ url: config.redis.url, prefix: 'project-test', queue: 'jobs' });
    expect(project.providers()).toEqual(['probe']);
    expect(project.openapi().build()).toEqual({ openapi: '3.1.0' });
    expect(await project.routes(config)).toBeArray();
  });

  test('opens the configured cache, and reports no session store without the auth module', async () => {
    const project = await apiProject(options);

    const cache = await project.cache?.(config);
    expect(cache?.driver).toBe('memory');
    expect(await cache?.clear()).toBeNumber();
    await cache?.close();
    expect(project.sessions).toBeUndefined();
  });

  test('overrides win, merging into paths and tools', async () => {
    const project = await apiProject({
      ...options,
      overrides: {
        apiPrefix: '/api/v2',
        paths: { config: 'src/config.ts' },
        tools: { scheduler: ['bun', 'run', 'bin/scheduler.ts'] },
      },
    });

    expect(project.apiPrefix).toBe('/api/v2');
    expect(project.paths.config).toBe('src/config.ts');
    expect(project.paths.modules).toBe('app/modules');
    expect(project.tools.scheduler).toEqual(['bun', 'run', 'bin/scheduler.ts']);
    expect(project.tools.worker).toEqual(['bun', 'run', 'bin/worker.ts']);
  });
});
