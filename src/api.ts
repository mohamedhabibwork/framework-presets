import { cacheHealthCheck, type CacheProviderConfig, createCacheProvider } from '@framework/cache';
import { defineProvider, EXECUTION_CONTEXT, type HealthCheck, type ServiceProvider } from '@framework/core';
import { DataPorter, LocalExportStore } from '@framework/crud';
import {
  AUDIT_READER,
  AuditReader,
  createConnection,
  DATA_CONTEXT,
  DATABASE,
  databaseHealthCheck,
  TRANSACTION_CONTEXT,
  TransactionContext,
} from '@framework/database';
import { EVENT_BUS, MemoryEventBus, RedisEventBus, WebsocketGateway } from '@framework/events';
import { resolve } from '@framework/http';
import { createLoggingProvider } from '@framework/logging';
import { createMailProvider, MAILER, type MailConfig } from '@framework/mail';
import {
  InMemoryNotificationStore,
  NOTIFICATION_STORE,
  NOTIFICATIONS,
  NotificationsService,
  type NotificationsServiceOptions,
} from '@framework/notifications';
import { QUEUE, QueueManager, queueHealthCheck } from '@framework/queue';
import { createStorageProvider, type StorageConfig } from '@framework/storage';
import { DATA_PORTER, EXPORT_STORE, WEBSOCKET_GATEWAY } from './constants';

/** The config sections the default providers read; apps add their own alongside. */
export interface ApiPresetConfig {
  readonly app: { readonly name: string };
  readonly database: { readonly url: string; readonly maxConnections: number };
  readonly redis: { readonly url: string };
  readonly queue: { readonly name: string; readonly prefix: string };
  readonly events: { readonly driver: 'memory' | 'redis' };
  readonly cache: CacheProviderConfig;
  readonly logging: object;
  readonly storage: StorageConfig;
  readonly mail: MailConfig;
  readonly notifications: { readonly providers?: NotificationsServiceOptions['providers'] };
}

/** `false` removes a part; a provider replaces it. */
type Part<TConfig extends object> = false | ServiceProvider<TConfig>;

type DataPorterOptions = ConstructorParameters<typeof DataPorter>[0];

export interface ApiPresetOptions<TConfig extends ApiPresetConfig> {
  readonly database?: Part<TConfig>;
  readonly cache?: Part<TConfig>;
  readonly queue?: Part<TConfig>;
  readonly events?: Part<TConfig>;
  readonly logging?: Part<TConfig>;
  readonly storage?: Part<TConfig>;
  readonly mail?: Part<TConfig>;
  /** The app's notification definitions and delivery job; the worker must run that job too. */
  readonly notifications: Part<TConfig> | Pick<NotificationsServiceOptions, 'definitions' | 'job'>;
  /** Import/export jobs behind the data routes. Defaults to none. */
  readonly data?: Part<TConfig> | Pick<DataPorterOptions, 'imports' | 'exports'>;
}

export interface ApiPreset<TConfig extends object> {
  /** List these in `defineApp({ providers })`; boot order comes from their dependencies. */
  readonly providers: readonly ServiceProvider<TConfig>[];
  /** Pass as `defineApp({ health })`: readiness probes for the parts still installed. */
  readonly health: { readonly checks: readonly HealthCheck[] };
}

const databaseProvider = <TConfig extends ApiPresetConfig>() =>
  defineProvider<TConfig>({
    name: 'database',
    register({ container, config }) {
      container.singleton(
        DATABASE,
        () =>
          createConnection({
            url: config.database.url,
            maxConnections: config.database.maxConnections,
            applicationName: config.app.name,
          }),
        (connection) => connection.close(),
      );
      container.scoped(TRANSACTION_CONTEXT, (r) => new TransactionContext(r.resolve(DATABASE).db));
      container.scoped(DATA_CONTEXT, (r) => ({
        transactions: r.resolve(TRANSACTION_CONTEXT),
        execution: r.resolve(EXECUTION_CONTEXT),
      }));
      container.scoped(AUDIT_READER, (r) => new AuditReader(r.resolve(TRANSACTION_CONTEXT).executor));
    },
  });

const queueProvider = <TConfig extends ApiPresetConfig>() =>
  defineProvider<TConfig>({
    name: 'queue',
    register({ container, config }) {
      container.singleton(
        QUEUE,
        () => new QueueManager({ url: config.redis.url, prefix: config.queue.prefix, queue: config.queue.name }),
        (queue) => queue.close(),
      );
    },
  });

const eventsProvider = <TConfig extends ApiPresetConfig>() =>
  defineProvider<TConfig>({
    name: 'events',
    register({ container, config }) {
      container.singleton(
        EVENT_BUS,
        () =>
          config.events.driver === 'redis'
            ? new RedisEventBus({ url: config.redis.url, prefix: config.app.name })
            : new MemoryEventBus(),
        (bus) => bus.close(),
      );
      container.singleton(
        WEBSOCKET_GATEWAY,
        (r) =>
          new WebsocketGateway({
            bus: r.resolve(EVENT_BUS),
            authenticate: (c) => resolve(c, EXECUTION_CONTEXT).actor,
            channels: ['events'],
            presence: true,
          }),
        (gateway) => gateway.close(),
      );
    },
  });

const dataProvider = <TConfig extends ApiPresetConfig>(jobs: Pick<DataPorterOptions, 'imports' | 'exports'>) =>
  defineProvider<TConfig>({
    name: 'data',
    dependsOn: ['queue'],
    register({ container }) {
      container.singleton(EXPORT_STORE, () => new LocalExportStore('storage/exports'));
      container.scoped(
        DATA_PORTER,
        (r) => new DataPorter({ queue: r.resolve(QUEUE), store: r.resolve(EXPORT_STORE), ...jobs }),
      );
    },
  });

const notificationsProvider = <TConfig extends ApiPresetConfig>(
  app: Pick<NotificationsServiceOptions, 'definitions' | 'job'>,
) =>
  defineProvider<TConfig>({
    name: 'notifications',
    dependsOn: ['mail', 'queue'],
    register({ container, config }) {
      if (!container.has(NOTIFICATION_STORE)) {
        container.singleton(NOTIFICATION_STORE, () => new InMemoryNotificationStore());
      }
      container.singleton(
        NOTIFICATIONS,
        (r) =>
          new NotificationsService({
            mailer: r.resolve(MAILER),
            queue: r.resolve(QUEUE),
            store: r.resolve(NOTIFICATION_STORE),
            ...app,
            ...(config.notifications.providers ? { providers: config.notifications.providers } : {}),
          }),
      );
    },
  });

const isProvider = <TConfig extends object>(value: object): value is ServiceProvider<TConfig> => 'register' in value;

/**
 * The providers a typical API needs: database, cache, queue, events, logging,
 * storage, mail, notifications and queued import/export. Each default reads
 * its section of the app's config. Replace or remove any part, and override
 * single bindings with `defineApp({ overrides })`:
 *
 * ```ts
 * const api = apiPreset<AppConfig>({ notifications: { definitions, job }, mail: myMailProvider, data: false });
 * export const app = defineApp<AppConfig>({ providers: api.providers, health: api.health, http });
 * ```
 */
export function apiPreset<TConfig extends ApiPresetConfig>(options: ApiPresetOptions<TConfig>): ApiPreset<TConfig> {
  const part = (choice: Part<TConfig> | undefined, fallback: () => ServiceProvider<TConfig>) =>
    choice === false ? [] : [choice ?? fallback()];
  const { data = { imports: [], exports: [] }, notifications } = options;

  return {
    providers: [
      ...part(options.database, databaseProvider<TConfig>),
      ...part(options.cache, () => createCacheProvider<TConfig>((config) => config.cache)),
      ...part(options.queue, queueProvider<TConfig>),
      ...part(options.events, eventsProvider<TConfig>),
      ...part(options.logging, () => createLoggingProvider<TConfig>((config) => config.logging)),
      ...part(options.storage, () => createStorageProvider<TConfig>()),
      ...part(options.mail, () => createMailProvider<TConfig>()),
      ...(data === false ? [] : [isProvider<TConfig>(data) ? data : dataProvider<TConfig>(data)]),
      ...(notifications === false
        ? []
        : [isProvider<TConfig>(notifications) ? notifications : notificationsProvider<TConfig>(notifications)]),
    ],
    health: {
      checks: [
        ...(options.database === false ? [] : [databaseHealthCheck()]),
        ...(options.cache === false ? [] : [cacheHealthCheck()]),
        ...(options.queue === false ? [] : [queueHealthCheck()]),
      ],
    },
  };
}
