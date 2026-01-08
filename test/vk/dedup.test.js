const test = require('node:test');
const assert = require('node:assert/strict');

const { buildKey, shouldProcessEvent, rememberEvent } = require('../../src/vk/dedup');

test('same input yields same key', () => {
  const ctx = {
    type: 'wall_post_new',
    group_id: 123,
    object: {
      post_id: 456,
      date: 1710000000
    }
  };
  const key1 = buildKey(ctx);
  const key2 = buildKey(JSON.parse(JSON.stringify(ctx)));

  assert.equal(key1, key2);
});

test('shouldProcessEvent is true before rememberEvent and false after', () => {
  const ctx = {
    type: 'photo_new',
    group_id: 321,
    object: {
      photo_id: 999,
      date: 1710001234
    }
  };

  assert.equal(shouldProcessEvent(ctx), true);
  rememberEvent(ctx);
  assert.equal(shouldProcessEvent(ctx), false);
});
