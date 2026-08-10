import { describe, it, expect } from 'vitest';
import { formatError } from '../src/utils/errors.js';

describe('formatError', () => {
  it('formats a standard Error', () => {
    const result = formatError(new Error('something went wrong'));
    expect(result).toContain('something went wrong');
  });

  it('formats a string', () => {
    const result = formatError('plain string error');
    expect(result).toContain('plain string error');
  });

  it('formats an unknown value', () => {
    const result = formatError(42);
    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
  });

  it('formats null', () => {
    const result = formatError(null);
    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
  });

  it('handles an object with status and message', () => {
    const apiError = { status: 404, message: 'Not Found', details: 'Page does not exist' };
    const result = formatError(apiError);
    expect(result).toContain('404');
    expect(result).toContain('Not Found');
  });
});
