const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
    createUiAuth,
    ensureUiAuthConfig,
    generateUiPassword,
    parseUiAuthEnabled
} = require('../src/web/auth');

test('UI authentication defaults to enabled and accepts only strict booleans', () => {
    assert.equal(parseUiAuthEnabled(undefined), true);
    assert.equal(parseUiAuthEnabled(''), true);
    assert.equal(parseUiAuthEnabled('true'), true);
    assert.equal(parseUiAuthEnabled('false'), false);
    assert.throws(() => parseUiAuthEnabled('yes'), /either true or false/);
    assert.throws(() => parseUiAuthEnabled('1'), /either true or false/);
});

test('UI password is generated once only when authentication is enabled', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-auth-env-'));
    const envPath = path.join(directory, '.env');
    const logs = [];
    const originalPassword = process.env.WA_UI_PASSWORD;
    try {
        delete process.env.WA_UI_PASSWORD;
        const first = ensureUiAuthConfig({ envPath, env: {}, log: (message) => logs.push(message) });
        const second = ensureUiAuthConfig({ envPath, env: {}, log: () => {} });
        assert.equal(first.enabled, true);
        assert.match(first.password, /^[A-Za-z0-9_-]{4}-[A-Za-z0-9_-]{4}-[A-Za-z0-9_-]{4}$/);
        assert.equal(second.password, first.password);
        assert.match(fs.readFileSync(envPath, 'utf8'), new RegExp(`WA_UI_PASSWORD=${first.password}`));
        assert.ok(logs.some((message) => message.includes(first.password)));

        fs.writeFileSync(envPath, 'WA_UI_AUTH_ENABLED=false\n');
        delete process.env.WA_UI_PASSWORD;
        const disabled = ensureUiAuthConfig({ envPath, env: {}, log: () => { throw new Error('must not log'); } });
        assert.deepEqual(disabled, { enabled: false, password: '' });
        assert.doesNotMatch(fs.readFileSync(envPath, 'utf8'), /WA_UI_PASSWORD/);
    } finally {
        if (originalPassword === undefined) delete process.env.WA_UI_PASSWORD;
        else process.env.WA_UI_PASSWORD = originalPassword;
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('generated UI passwords use grouped readable random text', () => {
    const password = generateUiPassword(() => Buffer.from('123456789'));
    assert.match(password, /^.{4}-.{4}-.{4}$/);
});

test('UI authentication creates expiring sessions and locks repeated failures', () => {
    let now = 1000;
    let tokenCounter = 0;
    const events = [];
    const auth = createUiAuth({
        enabled: true,
        password: 'secret-password',
        now: () => now,
        randomBytes: () => Buffer.from(String(++tokenCounter).padEnd(32, 'x')),
        activity: {
            info(type) { events.push(type); },
            error(type) { events.push(type); }
        },
        sessionMaxAgeMs: 100,
        lockoutMs: 30,
        maxFailedAttempts: 2
    });
    const request = { headers: {}, socket: { remoteAddress: '127.0.0.1' } };
    const headers = {};
    const response = { setHeader(name, value) { headers[name] = value; } };

    assert.equal(auth.signIn(request, response, 'bad').status, 401);
    assert.equal(auth.signIn(request, response, 'bad').status, 429);
    assert.equal(auth.signIn(request, response, 'secret-password').status, 429);
    now += 31;
    assert.equal(auth.signIn(request, response, 'secret-password').ok, true);
    const cookie = headers['Set-Cookie'].split(';')[0];
    const authenticated = { headers: { cookie }, socket: request.socket };
    assert.equal(auth.isAuthenticated(authenticated), true);
    now += 101;
    assert.equal(auth.isAuthenticated(authenticated), false);
    assert.ok(events.includes('ui.auth.failed'));
    assert.ok(events.includes('ui.auth.signed_in'));
});
