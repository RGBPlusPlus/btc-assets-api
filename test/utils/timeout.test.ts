import { describe, test, expect } from 'vitest';
import { withTimeout } from '../../src/utils/timeout';

describe('withTimeout', () => {
  test('should resolve when promise completes before timeout', async () => {
    const result = await withTimeout(Promise.resolve('success'), 1000, 'test');
    expect(result).toBe('success');
  });

  test('should reject when promise times out', async () => {
    const promise = new Promise(() => {}); // Never resolves
    await expect(withTimeout(promise, 50, 'test-op')).rejects.toThrow("Operation 'test-op' timed out after 50ms");
  });
});
