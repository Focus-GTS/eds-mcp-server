import { describe, it, expect } from 'vitest';
import { formatError, EdsApiError } from '../src/utils/errors.js';

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

  it('surfaces the underlying cause of a plain Error (previously unreachable)', () => {
    // A tightened isApiError no longer swallows plain Errors, so the cause of a
    // network failure (e.g. "fetch failed" caused by ENOTFOUND) is now shown.
    const err = new Error('fetch failed', { cause: new Error('ENOTFOUND admin.hlx.page') });
    const result = formatError(err);
    expect(result).toContain('fetch failed');
    expect(result).toContain('ENOTFOUND');
  });

  it('renders an EdsApiError with status and redacted url', () => {
    const err = new EdsApiError(429, 'Rate limited', { url: 'https://admin.hlx.page/x?domainkey=REDACTED' });
    const result = formatError(err);
    expect(result).toContain('429');
    expect(result).toContain('Rate limited');
    expect(result).toContain('REDACTED');
  });
});
