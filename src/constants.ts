import { token } from '@framework/core';
import type { DataPorter, ExportStore } from '@framework/crud';
import type { WebsocketGateway } from '@framework/events';

/** The WebSocket gateway behind `/ws`. */
export const WEBSOCKET_GATEWAY = token<WebsocketGateway>('events.websocket-gateway');

/** Shared export artifact store (local disk under storage/exports by default). */
export const EXPORT_STORE = token<ExportStore>('data.export-store');

/** Queued import/export dispatcher for the resources that opt in. */
export const DATA_PORTER = token<DataPorter>('data.porter');
