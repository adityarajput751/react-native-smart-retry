import type { AsyncStorageLike } from '../../src/storage/AsyncStorageStorage';

/**
 * In-memory stand-in for `@react-native-async-storage/async-storage`. Accepts
 * an external `Map` so tests can simulate an app restart by constructing a
 * fresh `AsyncStorageStorage` (or `SmartRetryClient`) against the same
 * "disk" without losing data.
 */
export function createMemoryAsyncStorage(backingStore = new Map<string, string>()): AsyncStorageLike {
  return {
    async getItem(key: string): Promise<string | null> {
      return backingStore.has(key) ? backingStore.get(key)! : null;
    },
    async setItem(key: string, value: string): Promise<void> {
      backingStore.set(key, value);
    },
    async removeItem(key: string): Promise<void> {
      backingStore.delete(key);
    },
    async multiGet(keys: string[]): Promise<Array<[string, string | null]>> {
      return keys.map((key) => [key, backingStore.has(key) ? backingStore.get(key)! : null]);
    },
    async multiSet(pairs: [string, string][]): Promise<void> {
      pairs.forEach(([key, value]) => backingStore.set(key, value));
    },
    async multiRemove(keys: string[]): Promise<void> {
      keys.forEach((key) => backingStore.delete(key));
    },
  };
}
