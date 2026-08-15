import test from 'node:test';
import assert from 'node:assert/strict';
import { getScrollIndicators } from '../src/menu.js';

test('scrolling lists always show both counters, including zero at the upper boundary', () => {
  assert.deepEqual(
    getScrollIndicators({ choicesLength: 5, visibleCount: 3, scrollOffset: 0 }),
    { show: true, above: 0, below: 2 }
  );
});

test('scrolling lists always show both counters, including zero at the lower boundary', () => {
  assert.deepEqual(
    getScrollIndicators({ choicesLength: 5, visibleCount: 3, scrollOffset: 2 }),
    { show: true, above: 2, below: 0 }
  );
});

test('lists that fit completely do not show scroll counters', () => {
  assert.deepEqual(
    getScrollIndicators({ choicesLength: 3, visibleCount: 3, scrollOffset: 0 }),
    { show: false, above: 0, below: 0 }
  );
});
