import { describe, expect, it } from 'vitest';
import { parseBooleanQuery } from './query';

describe('http query', () => {
  it('布尔查询参数只接受 true 或 false', () => {
    expect(parseBooleanQuery(undefined, 'flag')).toBeNull();
    expect(parseBooleanQuery('true', 'flag')).toBe(true);
    expect(parseBooleanQuery('false', 'flag')).toBe(false);
    expect(() => parseBooleanQuery('1', 'flag')).toThrow('flag 仅支持 true 或 false');
    expect(() => parseBooleanQuery('yes', 'flag')).toThrow('flag 仅支持 true 或 false');
    expect(() => parseBooleanQuery('TRUE', 'flag')).toThrow('flag 仅支持 true 或 false');
  });
});
