const crypto = require('crypto');
const path = require('path');
const { loadEnvValue, saveEnvValue } = require('../env');

const AUTH_ENABLED_KEY = 'WA_UI_AUTH_ENABLED';
const PASSWORD_KEY = 'WA_UI_PASSWORD';
const SESSION_COOKIE = 'wa_scheduler_session';

function parseUiAuthEnabled(value) {
    if (value === undefined || value === null || value === '') return true;
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw new Error(`${AUTH_ENABLED_KEY} must be either true or false`);
}

function generateUiPassword(randomBytes = crypto.randomBytes) {
    const value = randomBytes(9).toString('base64url');
    return value.match(/.{1,4}/g).join('-');
}

function ensureUiAuthConfig({ envPath = '.env', env = process.env, log = console.log } = {}) {
    const enabled = parseUiAuthEnabled(env[AUTH_ENABLED_KEY] ?? loadEnvValue(AUTH_ENABLED_KEY, envPath));
    if (!enabled) return { enabled: false, password: '' };

    const current = loadEnvValue(PASSWORD_KEY, envPath) || env[PASSWORD_KEY] || '';
    if (current) return { enabled: true, password: current };

    const password = saveEnvValue(PASSWORD_KEY, generateUiPassword(), envPath);
    log('Web UI password was generated.');
    log('Open the local web UI and sign in with:');
    log(`Password: ${password}`);
    return { enabled: true, password };
}

function parseCookies(header = '') {
    return String(header).split(';').reduce((cookies, part) => {
        const index = part.indexOf('=');
        if (index < 0) return cookies;
        const key = part.slice(0, index).trim();
        const value = part.slice(index + 1).trim();
        if (key) cookies[key] = decodeURIComponent(value);
        return cookies;
    }, {});
}

function constantTimeEqual(left, right) {
    const a = Buffer.from(String(left));
    const b = Buffer.from(String(right));
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

function createUiAuth({
    enabled,
    password,
    activity = null,
    now = () => Date.now(),
    randomBytes = crypto.randomBytes,
    sessionMaxAgeMs = 12 * 60 * 60 * 1000,
    maxFailedAttempts = 5,
    lockoutMs = 30 * 1000
}) {
    const sessions = new Map();
    const failures = new Map();

    function clientKey(request) {
        return request.socket?.remoteAddress || 'local';
    }

    function sessionToken(request) {
        return parseCookies(request.headers.cookie)[SESSION_COOKIE] || '';
    }

    function isAuthenticated(request) {
        if (!enabled) return true;
        const token = sessionToken(request);
        if (!token) return false;
        const expiresAt = sessions.get(token);
        if (!expiresAt) return false;
        if (expiresAt <= now()) {
            sessions.delete(token);
            return false;
        }
        return true;
    }

    function setSessionCookie(response, token) {
        const maxAge = Math.floor(sessionMaxAgeMs / 1000);
        response.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`);
    }

    function clearSessionCookie(response) {
        response.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    }

    function signIn(request, response, candidate) {
        if (!enabled) return { ok: true };
        const key = clientKey(request);
        const state = failures.get(key);
        if (state?.lockedUntil > now()) {
            return { ok: false, status: 429, error: 'Too many failed attempts. Try again in 30 seconds.' };
        }

        if (!constantTimeEqual(candidate, password)) {
            const attempts = (state?.attempts || 0) + 1;
            const lockedUntil = attempts >= maxFailedAttempts ? now() + lockoutMs : 0;
            failures.set(key, { attempts: lockedUntil ? 0 : attempts, lockedUntil });
            activity?.error('ui.auth.failed', { message: 'UI sign-in failed' });
            return {
                ok: false,
                status: lockedUntil ? 429 : 401,
                error: lockedUntil ? 'Too many failed attempts. Try again in 30 seconds.' : 'Incorrect password'
            };
        }

        failures.delete(key);
        const token = randomBytes(32).toString('base64url');
        sessions.set(token, now() + sessionMaxAgeMs);
        setSessionCookie(response, token);
        activity?.info('ui.auth.signed_in', { message: 'UI sign-in succeeded' });
        return { ok: true };
    }

    function signOut(request, response) {
        const token = sessionToken(request);
        if (token) sessions.delete(token);
        clearSessionCookie(response);
        activity?.info('ui.auth.signed_out', { message: 'UI signed out' });
    }

    function middleware(request, response, next) {
        if (isAuthenticated(request)) return next();
        if (request.path.startsWith('/api/')) {
            return response.status(401).json({ error: 'Authentication required' });
        }
        return response.redirect(303, '/login');
    }

    return {
        enabled,
        isAuthenticated,
        middleware,
        signIn,
        signOut,
        sessions
    };
}

function loginPagePath() {
    return path.resolve('public/login.html');
}

module.exports = {
    AUTH_ENABLED_KEY,
    PASSWORD_KEY,
    SESSION_COOKIE,
    createUiAuth,
    ensureUiAuthConfig,
    generateUiPassword,
    loginPagePath,
    parseCookies,
    parseUiAuthEnabled
};
