const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const app = fs.readFileSync('public/app.js', 'utf8');
const html = fs.readFileSync('public/index.html', 'utf8');

test('notification settings use autosave instead of a save button', () => {
    assert.doesNotMatch(app, /save-notifications/);
    assert.doesNotMatch(html, /Save notifications/);
    assert.match(html, /notification-save-status/);
    assert.match(app, /notificationsEl\.addEventListener\('change'/);
    assert.match(app, /queueNotificationSave\(600\)/);
});

test('notification autosave preserves the current form and flushes before tests', () => {
    const saveStart = app.indexOf('async function saveNotifications');
    const saveEnd = app.indexOf('function queueNotificationSave', saveStart);
    const saveBody = app.slice(saveStart, saveEnd);

    assert.doesNotMatch(saveBody, /renderNotifications\(\)/);
    assert.match(app, /await flushNotificationSave\(\);[\s\S]*\/api\/notifications\/test/);
    assert.match(app, /window\.addEventListener\('beforeunload'/);
    assert.match(app, /Save failed/);
});
