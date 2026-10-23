import { describe, expect, it } from 'vitest';
import { parseByteRange } from '../server/range';

describe('parseByteRange', () => {
  it('handles open, closed and suffix ranges', () => {
    expect(parseByteRange('bytes=0-', 100)).toEqual({ kind: 'valid', range: { start: 0, end: 99, length: 100 } });
    expect(parseByteRange('bytes=10-19', 100)).toEqual({ kind: 'valid', range: { start: 10, end: 19, length: 10 } });
    expect(parseByteRange('bytes=-10', 100)).toEqual({ kind: 'valid', range: { start: 90, end: 99, length: 10 } });
  });
  it('rejects ranges past the end and multi-ranges', () => {
    expect(parseByteRange('bytes=200-', 100).kind).toBe('invalid');
    expect(parseByteRange('bytes=0-1,5-6', 100).kind).toBe('invalid');
  });
});
