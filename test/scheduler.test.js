const assert = require('node:assert/strict');
const test = require('node:test');
const { dateKey } = require('../src/scheduler');

test('dateKey uses the configured timezone', () => {
    const date = new Date('2026-07-12T21:30:00.000Z');

    assert.equal(dateKey(date, 'Europe/Kyiv'), '2026-07-13');
});
