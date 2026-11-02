import { describe, expect, test } from 'bun:test';
import { Application, defineProvider, type ServiceProvider } from '@framework/core';
import { DATABASE } from '@framework/database';
import { EVENT_BUS } from '@framework/events';
import { defineNotificationJob, NOTIFICATIONS } from '@framework/notifications';
import { QUEUE } from '@framework/queue';
import { type ApiPresetConfig, apiPreset, DATA_PORTER, EXPORT_STORE, WEBSOCKET_GATEWAY } from '../src';

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) throw new Error('REDIS_URL is not set; run `bun run db:up` and see .env.test.example');

const config: ApiPresetConfig = {
  app: { name: 'preset-test' },
  database: { url: 'postgres://app:unused@127.0.0.1:1/unused', maxConnections: 1 },
  redis: { url: redisUrl },
  queue: { name: 'preset-tests', prefix: `preset-${crypto.randomUUID()}` },
  events: { driver: 'memory' },
  cache: { driver: 'memory' },
  logging: { level: 'info', driver: 'memory', name: 'preset-test' },
  storage: { default: 'local', disks: { local: { driver: 'local', root: 'storage', visibility: 'private' } } },
  mail: { driver: 'memory', from: 'no-reply@preset.test' },
  notifications: {},
};
const notifications = { definitions: [], job: defineNotificationJob() };
const names = (providers: readonly ServiceProvider<ApiPresetConfig>[]) => providers.map((provider) => provider.name);

describe('apiPreset', () => {
  test('installs the API stack, and it boots with every service resolvable', async () => {
    const preset = apiPreset({ notifications });

    expect(names(preset.providers).toSorted()).toEqual(
      ['cache', 'data', 'database', 'events', 'logging', 'mail', 'notifications', 'queue', 'storage'].toSorted(),
    );

    const application = await new Application<ApiPresetConfig>({ config, providers: preset.providers }).boot();
    try {
      const { container } = application;
      for (const key of [DATABASE, EVENT_BUS, QUEUE, WEBSOCKET_GATEWAY, EXPORT_STORE, NOTIFICATIONS]) {
        expect(container.has(key)).toBe(true);
      }
      expect(container.has(DATA_PORTER)).toBe(true);
      expect(container.resolve(NOTIFICATIONS)).toBeDefined();
    } finally {
      await application.shutdown();
    }
  });

  test('probes the database, cache and queue for readiness', () => {
    const checks = apiPreset({ notifications }).health.checks;
    expect(checks.map((check) => check.name).toSorted()).toEqual(['cache', 'database', 'queue']);
  });

  test('false removes a part, along with its readiness probe', () => {
    const preset = apiPreset({ notifications: false, data: false, cache: false, mail: false });

    expect(names(preset.providers)).not.toContain('cache');
    expect(names(preset.providers)).not.toContain('notifications');
    expect(names(preset.providers)).not.toContain('data');
    expect(preset.health.checks.map((check) => check.name)).not.toContain('cache');
  });

  test('a provider replaces that part, and keeps its readiness probe', () => {
    const database = defineProvider<ApiPresetConfig>({ name: 'custom-database', register: () => {} });
    const preset = apiPreset({ notifications, database });

    expect(names(preset.providers)).toContain('custom-database');
    expect(names(preset.providers)).not.toContain('database');
    expect(preset.health.checks.map((check) => check.name)).toContain('database');
  });
});
