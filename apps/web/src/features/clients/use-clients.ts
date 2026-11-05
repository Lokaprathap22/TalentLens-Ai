import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  createClient,
  listClients,
  resolveClientErrorMessage,
  updateClient,
} from './client.api.js';
import type {
  ClientFilterStatus,
  ClientRecord,
  ClientStatus,
  ClientSummaryCounts,
} from './types.js';

export type ClientsDirectoryState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; clients: ClientRecord[] };

const nameCollator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

export function sortClientsByName(clients: readonly ClientRecord[]): ClientRecord[] {
  return [...clients].sort((left, right) => {
    const byName = nameCollator.compare(left.name, right.name);
    if (byName !== 0) {
      return byName;
    }
    return left.id.localeCompare(right.id);
  });
}

export function computeClientSummaryCounts(clients: readonly ClientRecord[]): ClientSummaryCounts {
  let active = 0;
  let inactive = 0;
  for (const client of clients) {
    if (client.status === 'ACTIVE') {
      active += 1;
    } else {
      inactive += 1;
    }
  }
  return {
    total: clients.length,
    active,
    inactive,
  };
}

export function filterClients(
  clients: readonly ClientRecord[],
  statusFilter: ClientFilterStatus,
  searchQuery: string,
): ClientRecord[] {
  const normalizedQuery = searchQuery.trim().toLowerCase();

  return clients.filter((client) => {
    if (statusFilter !== 'ALL' && client.status !== statusFilter) {
      return false;
    }
    if (normalizedQuery.length > 0 && !client.name.toLowerCase().includes(normalizedQuery)) {
      return false;
    }
    return true;
  });
}

export interface UseClientsResult {
  state: ClientsDirectoryState;
  clients: ClientRecord[];
  summary: ClientSummaryCounts;
  reload: () => Promise<void>;
  createClientRecord: (name: string) => Promise<ClientRecord>;
  updateClientName: (clientId: string, name: string) => Promise<ClientRecord>;
  updateClientStatus: (clientId: string, status: ClientStatus) => Promise<ClientRecord>;
}

export function useClients(): UseClientsResult {
  const [state, setState] = useState<ClientsDirectoryState>({ status: 'loading' });
  const mountedRef = useRef(true);
  const fetchVersionRef = useRef(0);

  const executeFetch = useCallback(async (version: number): Promise<void> => {
    try {
      const records = await listClients();
      if (!mountedRef.current || fetchVersionRef.current !== version) {
        return;
      }
      setState({
        status: 'ready',
        clients: sortClientsByName(records),
      });
    } catch (error) {
      if (!mountedRef.current || fetchVersionRef.current !== version) {
        return;
      }
      setState({
        status: 'error',
        message: resolveClientErrorMessage(
          error,
          'Unable to load the client directory right now. Please try again.',
        ),
      });
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const initialVersion = ++fetchVersionRef.current;
    void executeFetch(initialVersion);

    return () => {
      mountedRef.current = false;
      fetchVersionRef.current += 1;
    };
  }, [executeFetch]);

  const reload = useCallback(async (): Promise<void> => {
    const version = ++fetchVersionRef.current;
    setState({ status: 'loading' });
    await executeFetch(version);
  }, [executeFetch]);

  const reconcileClient = useCallback((updatedRecord: ClientRecord): void => {
    if (!mountedRef.current) {
      return;
    }
    setState((previous) => {
      if (previous.status !== 'ready') {
        return previous;
      }
      const exists = previous.clients.some((item) => item.id === updatedRecord.id);
      const nextClients = exists
        ? previous.clients.map((item) => (item.id === updatedRecord.id ? updatedRecord : item))
        : [...previous.clients, updatedRecord];

      return {
        status: 'ready',
        clients: sortClientsByName(nextClients),
      };
    });
  }, []);

  const createClientRecord = useCallback(
    async (name: string): Promise<ClientRecord> => {
      const created = await createClient({ name });
      reconcileClient(created);
      return created;
    },
    [reconcileClient],
  );

  const updateClientName = useCallback(
    async (clientId: string, name: string): Promise<ClientRecord> => {
      const updated = await updateClient(clientId, { name });
      reconcileClient(updated);
      return updated;
    },
    [reconcileClient],
  );

  const updateClientStatus = useCallback(
    async (clientId: string, status: ClientStatus): Promise<ClientRecord> => {
      const updated = await updateClient(clientId, { status });
      reconcileClient(updated);
      return updated;
    },
    [reconcileClient],
  );

  const clients = useMemo(() => (state.status === 'ready' ? state.clients : []), [state]);

  const summary = useMemo(() => computeClientSummaryCounts(clients), [clients]);

  return {
    state,
    clients,
    summary,
    reload,
    createClientRecord,
    updateClientName,
    updateClientStatus,
  };
}
