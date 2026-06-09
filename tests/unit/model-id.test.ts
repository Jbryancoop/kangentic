import { describe, it, expect } from 'vitest';
import { parseModelId, groupModelIds } from '../../src/shared/model-id';

describe('parseModelId', () => {
  it('passes through ids with no recognized suffix', () => {
    for (const id of ['opus', 'claude-opus-4-8', 'gpt-5-mini', 'gemini-2.5-pro']) {
      expect(parseModelId(id)).toEqual({
        id,
        baseId: id,
        isOneMillionVariant: false,
        datedSnapshot: null,
      });
    }
  });

  it('strips a trailing [1m] suffix and flags the variant', () => {
    expect(parseModelId('claude-opus-4-8[1m]')).toEqual({
      id: 'claude-opus-4-8[1m]',
      baseId: 'claude-opus-4-8',
      isOneMillionVariant: true,
      datedSnapshot: null,
    });
  });

  it('strips a trailing dated suffix and captures the date', () => {
    expect(parseModelId('claude-haiku-4-5-20251001')).toEqual({
      id: 'claude-haiku-4-5-20251001',
      baseId: 'claude-haiku-4-5',
      isOneMillionVariant: false,
      datedSnapshot: '20251001',
    });
  });

  it('handles a dated id that also carries the [1m] suffix', () => {
    expect(parseModelId('claude-opus-4-8-20260301[1m]')).toEqual({
      id: 'claude-opus-4-8-20260301[1m]',
      baseId: 'claude-opus-4-8',
      isOneMillionVariant: true,
      datedSnapshot: '20260301',
    });
  });

  it('keeps an implausible 8-digit tail as part of the base id', () => {
    expect(parseModelId('claude-opus-4-8-20251399')).toEqual({
      id: 'claude-opus-4-8-20251399',
      baseId: 'claude-opus-4-8-20251399',
      isOneMillionVariant: false,
      datedSnapshot: null,
    });
    expect(parseModelId('some-model-19991231').datedSnapshot).toBeNull();
  });

  it('handles the empty string', () => {
    expect(parseModelId('')).toEqual({
      id: '',
      baseId: '',
      isOneMillionVariant: false,
      datedSnapshot: null,
    });
  });
});

describe('groupModelIds', () => {
  it('collapses alias, [1m] variant, and dated pin into one group', () => {
    const groups = groupModelIds([
      'claude-opus-4-8',
      'claude-opus-4-8[1m]',
      'claude-opus-4-8-20260101',
    ]);
    expect(groups).toEqual([
      {
        primaryId: 'claude-opus-4-8',
        oneMillionId: 'claude-opus-4-8[1m]',
        primaryIsOneMillion: false,
        pinnedBuildIds: ['claude-opus-4-8-20260101'],
      },
    ]);
  });

  it('promotes the newest dated form when no bare alias exists', () => {
    const groups = groupModelIds([
      'claude-haiku-4-5-20251001',
      'claude-haiku-4-5-20250601',
    ]);
    expect(groups).toEqual([
      {
        primaryId: 'claude-haiku-4-5-20251001',
        oneMillionId: null,
        primaryIsOneMillion: false,
        pinnedBuildIds: ['claude-haiku-4-5-20250601'],
      },
    ]);
  });

  it('uses the [1m] form as primary when only that form exists', () => {
    const groups = groupModelIds(['claude-opus-4-7[1m]']);
    expect(groups).toEqual([
      {
        primaryId: 'claude-opus-4-7[1m]',
        oneMillionId: null,
        primaryIsOneMillion: true,
        pinnedBuildIds: [],
      },
    ]);
  });

  it('keeps a dated [1m] combo as a pinned entry verbatim', () => {
    const groups = groupModelIds(['claude-opus-4-8', 'claude-opus-4-8-20260301[1m]']);
    expect(groups).toEqual([
      {
        primaryId: 'claude-opus-4-8',
        oneMillionId: null,
        primaryIsOneMillion: false,
        pinnedBuildIds: ['claude-opus-4-8-20260301[1m]'],
      },
    ]);
  });

  it('leaves suffix-free ids as their own single-member groups', () => {
    const groups = groupModelIds(['gpt-5-mini', 'gpt-5-codex', 'opus']);
    expect(groups).toEqual([
      { primaryId: 'gpt-5-codex', oneMillionId: null, primaryIsOneMillion: false, pinnedBuildIds: [] },
      { primaryId: 'gpt-5-mini', oneMillionId: null, primaryIsOneMillion: false, pinnedBuildIds: [] },
      { primaryId: 'opus', oneMillionId: null, primaryIsOneMillion: false, pinnedBuildIds: [] },
    ]);
  });

  it('groups a mixed multi-agent list without touching foreign ids', () => {
    const groups = groupModelIds([
      'claude-opus-4-8[1m]',
      'gpt-5-mini',
      'claude-opus-4-8',
      'claude-haiku-4-5-20251001',
    ]);
    expect(groups.map((group) => group.primaryId)).toEqual([
      'claude-haiku-4-5-20251001',
      'claude-opus-4-8',
      'gpt-5-mini',
    ]);
    expect(groups[1]?.oneMillionId).toBe('claude-opus-4-8[1m]');
  });

  it('sorts pinned builds newest first', () => {
    const groups = groupModelIds([
      'claude-haiku-4-5',
      'claude-haiku-4-5-20250601',
      'claude-haiku-4-5-20251001',
    ]);
    expect(groups[0]?.pinnedBuildIds).toEqual([
      'claude-haiku-4-5-20251001',
      'claude-haiku-4-5-20250601',
    ]);
  });

  it('deduplicates repeated ids', () => {
    const groups = groupModelIds(['claude-opus-4-8', 'claude-opus-4-8']);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.pinnedBuildIds).toEqual([]);
  });

  it('is idempotent on an already-clean list', () => {
    const clean = ['claude-haiku-4-5', 'claude-opus-4-8', 'claude-sonnet-4-6'];
    const groups = groupModelIds(clean);
    expect(groups.map((group) => group.primaryId)).toEqual(clean);
    expect(groups.every((group) => group.oneMillionId === null && group.pinnedBuildIds.length === 0)).toBe(true);
  });
});
