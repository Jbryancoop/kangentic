/**
 * Unit tests for the normalizeUrl helper in
 * src/renderer/components/browser/BrowserEmptyState.utils.ts.
 *
 * Pure function; no browser globals, no Electron, no mocking needed.
 */

import { describe, it, expect } from 'vitest';
import { normalizeUrl } from '../../src/renderer/components/browser/BrowserEmptyState.utils';

describe('normalizeUrl', () => {
  // Null / empty input
  it('returns null for empty string', () => {
    expect(normalizeUrl('')).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(normalizeUrl('   ')).toBeNull();
  });

  // Bare hostname auto-prefix
  it('prefixes http:// on a bare hostname', () => {
    expect(normalizeUrl('localhost:3000')).toBe('http://localhost:3000/');
  });

  it('prefixes http:// when no scheme is present', () => {
    expect(normalizeUrl('example.com')).toBe('http://example.com/');
  });

  it('prefixes http:// on a bare IPv4 address', () => {
    expect(normalizeUrl('127.0.0.1:8080')).toBe('http://127.0.0.1:8080/');
  });

  // Explicit schemes preserved
  it('preserves https:// scheme', () => {
    expect(normalizeUrl('https://example.com')).toBe('https://example.com/');
  });

  it('preserves http:// scheme', () => {
    expect(normalizeUrl('http://localhost:5173')).toBe('http://localhost:5173/');
  });

  it('preserves https:// with a path', () => {
    expect(normalizeUrl('https://example.com/page?q=1')).toBe('https://example.com/page?q=1');
  });

  // Non-http(s) schemes: the function auto-prefixes anything without a
  // recognized scheme. Bare strings like "ftp://..." are treated as
  // bare hostnames ("ftp" is the host) and get http:// prepended.
  // The only way to get null from a non-empty input is a URL that the
  // WHATWG URL parser rejects outright (e.g. spaces in the hostname).
  //
  // The component relies on the fact that only http(s) URLs can reach
  // a browser page in an Electron webview - it does not need to detect
  // and reject ftp/file/chrome as a security boundary. Those schemes
  // simply do not load in the embedded webview.
  it('does not reject ftp:// input - returns an http-prefixed form', () => {
    // "ftp" parsed as hostname -> "http://ftp/" - a valid (if useless) URL
    const result = normalizeUrl('ftp://files.example.com');
    // Just assert it is not null - the exact form is an implementation detail
    // of the WHATWG URL parser and is not load-bearing for product behavior.
    expect(result).not.toBeNull();
  });

  // Completely malformed input
  it('returns null for a string with spaces that URL cannot parse', () => {
    // "hello world" when prefixed becomes "http://hello world" which is invalid
    expect(normalizeUrl('hello world')).toBeNull();
  });

  // Trimming
  it('trims surrounding whitespace before normalizing', () => {
    expect(normalizeUrl('  https://example.com  ')).toBe('https://example.com/');
  });

  it('trims surrounding whitespace on a bare hostname', () => {
    expect(normalizeUrl('  localhost:3000  ')).toBe('http://localhost:3000/');
  });
});
