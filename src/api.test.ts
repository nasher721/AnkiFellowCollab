import { describe, it, expect, vi } from 'vitest';
import { createCancellableFetch } from './api';

describe('createCancellableFetch', () => {
  it('should create an object with promise and cancel', () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation((_url, options) => {
      return new Promise((resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    });

    const { promise, cancel } = createCancellableFetch('/api/test');
    expect(typeof promise.then).toBe('function');
    expect(typeof cancel).toBe('function');

    cancel();

    return expect(promise).rejects.toMatchObject({ name: 'AbortError' })
      .finally(() => {
        globalThis.fetch = originalFetch;
      });
  });
});
