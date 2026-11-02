import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryCache, RedisCache } from '@framework/cache';
import {
  defineProject,
  type ProjectAdapter,
  type ProjectPaths,
  type ProjectTools,
  type SessionPruneHandle,
} from '@framework/cli';
import { createConnection, type DatabaseConnection, type Seeder } from '@framework/database';
import { type AppDefinition, listRoutes, type MiddlewareDescription } from '@framework/http';
import type { Operation } from '@framework/openapi';
import type { ApiPresetConfig } from './api';

const DEFAULT_PATHS: ProjectPaths = {
  modules: 'app/modules',
  schemaDir: 'database/schema',
  schemaIndex: 'database/schema/index.ts',
  factories: 'database/factories',
  migrations: 'database/migrations',
  app: 'bootstrap/app.ts',
  providers: 'bootstrap/app.ts',
  middleware: 'bootstrap/middleware.ts',
  config: 'config/index.ts',
  testSupport: 'tests/support.ts',
};

const DEFAULT_TOOLS: ProjectTools = {
  typecheck: ['bunx', 'tsc', '-p', 'tsconfig.json'],
  test: ['bun', 'test'],
  lint: ['bunx', 'oxlint', '.'],
  format: ['bunx', 'oxfmt', '.'],
  drizzleKit: ['bunx', 'drizzle-kit'],
  dev: ['bun', 'run', '--hot', 'bin/server.ts'],
  serve: ['bun', 'run', 'bin/server.ts'],
  worker: ['bun', 'run', 'bin/worker.ts'],
};

export interface ApiProjectOptions<TConfig extends ApiPresetConfig> {
  readonly name: string;
  /** Pinned in the app, so version checks see it. */
  readonly frameworkVersion: string;
  /** The project root, from the entry point's location and never the shell's cwd. */
  readonly root: string;
  readonly app: AppDefinition<TConfig, Operation>;
  readonly loadConfig: (options: { readonly envFile?: string }) => Promise<TConfig>;
  readonly createMiddleware: (config: TConfig) => { describe(): readonly MiddlewareDescription[] };
  readonly buildOpenApiDocument: (version?: string) => object;
  readonly seeders?: () => Promise<readonly Seeder[]>;
  /** Anything else: `paths` and `tools` merge over the defaults, the rest replaces them. */
  readonly overrides?: Partial<Omit<ProjectAdapter, 'paths' | 'tools'>> & {
    readonly paths?: Partial<ProjectPaths>;
    readonly tools?: Partial<ProjectTools>;
  };
}

/**
 * `make:auth` installs the auth package into an existing application, so a new
 * app has neither: this hook exists only once the module does, and the package
 * resolves from the app's root. Without it, `session:prune` reports itself as
 * unsupported and points at `make:auth`.
 */
function sessionsHook<TConfig extends ApiPresetConfig>(root: string): ProjectAdapter['sessions'] {
  if (!existsSync(join(root, 'app/modules/auth/provider.ts'))) return undefined;
  return async (rawConfig): Promise<SessionPruneHandle> => {
    const config = rawConfig as TConfig;
    const auth = (await import(Bun.resolveSync('@framework/auth', root))) as {
      PgSessionStore: new (connection: DatabaseConnection) => Omit<SessionPruneHandle, 'close'>;
    };
    const connection = createConnection({
      url: config.database.url,
      maxConnections: config.database.maxConnections,
      applicationName: config.app.name,
    });
    const store = new auth.PgSessionStore(connection);
    return {
      countExpired: (now) => store.countExpired(now),
      prune: (now) => store.prune(now),
      close: () => connection.close(),
    };
  };
}

/**
 * The CLI adapter for an app built on `apiPreset` and the conventional layout.
 * Config-dependent commands open their own resources on demand, so nothing
 * connects until a command needs it.
 *
 * ```ts
 * export const project = await apiProject({ name, frameworkVersion, root, app, loadConfig, createMiddleware, buildOpenApiDocument });
 * ```
 */
export async function apiProject<TConfig extends ApiPresetConfig>(
  options: ApiProjectOptions<TConfig>,
): Promise<ProjectAdapter> {
  const {
    name,
    frameworkVersion,
    root,
    app,
    loadConfig,
    createMiddleware,
    buildOpenApiDocument,
    seeders,
    overrides = {},
  } = options;
  const envFile = join(root, '.env');
  // The middleware alias table is config-driven; load it once for `middleware:list`.
  const middleware = createMiddleware(await loadConfig({ envFile }));
  const sessions = sessionsHook<TConfig>(root);

  return defineProject({
    name,
    root,
    frameworkVersion,
    apiPrefix: '/api/v1',
    loadConfig: (file) => loadConfig({ envFile: file ?? envFile }),
    databaseUrl: (config) => (config as TConfig).database.url,
    queueUrl: (config) => {
      const { redis, queue } = config as TConfig;
      return { url: redis.url, prefix: queue.prefix, queue: queue.name };
    },
    cache: async (rawConfig) => {
      const { driver, redis } = (rawConfig as TConfig).cache;
      const cache = driver === 'redis' && redis ? new RedisCache(redis) : new MemoryCache();
      return { driver: driver ?? 'memory', clear: () => cache.clear(), close: () => cache.close() };
    },
    ...(sessions ? { sessions } : {}),
    routes: async (config) => {
      // Booting only registers bindings (nothing connects); it makes the
      // listed route table match what the server actually serves.
      const booted = await app.createApplication(config as TConfig).boot();
      try {
        return listRoutes(app.createHttp(booted));
      } finally {
        await booted.shutdown();
      }
    },
    providers: () => app.providers.map((provider) => provider.name),
    ...(seeders ? { seeders } : {}),
    middleware: () => middleware.describe(),
    openapi: () => ({ operations: app.operations, build: buildOpenApiDocument }),
    ...overrides,
    paths: { ...DEFAULT_PATHS, ...overrides.paths },
    tools: { ...DEFAULT_TOOLS, ...overrides.tools },
  });
}
