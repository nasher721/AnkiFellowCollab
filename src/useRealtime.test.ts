import { describe, expect, it } from 'vitest';

describe('useRealtime', () => {
  it('should be importable', async () => {
    const { useRealtime } = await import('./useRealtime');
    expect(useRealtime).toBeDefined();
    expect(typeof useRealtime).toBe('function');
  });
});
