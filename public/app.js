const state = { jobs: [], recipients: [], notifications: null, timezone: '', editingFiles: [], activity: [], activityFilter: 'all' };
const $ = (selector) => document.querySelector(selector);
const jobsEl = $('#jobs');
const recipientsEl = $('#recipients');
const jobDialog = $('#job-dialog');
const recipientDialog = $('#recipient-dialog');
const activityEl = $('#activity');
const notificationsEl = $('#notifications');
const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const notificationSave = { timer: null, retryTimer: null, dirty: false, saving: null, revision: 0, retryRevision: null };

function formatDateTime(value) {
    if (!value) return '';
    return new Intl.DateTimeFormat([], {
        day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
    }).format(new Date(value));
}

function lastRunLabel(lastRun) {
    if (!lastRun) return 'Last: never';
    const status = lastRun.status === 'sent' ? 'Completed'
        : lastRun.status === 'partial' ? `Partial · ${lastRun.sentItems}/${lastRun.totalItems} items`
            : lastRun.status === 'failed' ? 'Failed'
                : lastRun.status === 'retrying' ? `Retry ${lastRun.retry?.attempt || '?'} pending`
                    : lastRun.status === 'running' ? 'Running' : lastRun.status;
    const timestamp = lastRun.status === 'retrying' && lastRun.retry?.nextRetryAt
        ? lastRun.retry.nextRetryAt
        : lastRun.timestamp || `${lastRun.date}T00:00:00`;
    return `Last: ${status} · ${formatDateTime(timestamp)}`;
}

async function api(url, options = {}) {
    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed: ${response.status}`);
    return data;
}

function toast(message) {
    const element = $('#toast');
    element.textContent = message;
    element.classList.add('show');
    setTimeout(() => element.classList.remove('show'), 2200);
}

function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, (character) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    })[character]);
}

function scheduleLabel(cron) {
    const parts = cron.trim().split(/\s+/);
    if (parts.length !== 5) return cron;
    const [minute, hour, monthDay, month, weekDay] = parts;
    const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    if (monthDay === '*' && month === '*' && weekDay === '*') return `Every day · ${time}`;
    if (monthDay === '*' && month === '*' && /^\d$/.test(weekDay)) return `Every ${weekdays[Number(weekDay)]} · ${time}`;
    if (/^\d{1,2}$/.test(monthDay) && month === '*' && weekDay === '*') return `Day ${monthDay} of every month · ${time}`;
    return `Cron ${cron}`;
}



const notificationEventLabels = {
    'job.completed': 'Job completed',
    'job.failed': 'Job failed',
    'job.partial': 'Job partially sent',
    'job.catchup.started': 'Missed run started late',
    'job.retry.scheduled': 'Retry scheduled',
    'job.recovered': 'Job recovered',
    'job.retry.exhausted': 'Retries exhausted',
    'job.manual.completed': 'Manual send completed',
    'job.manual.failed': 'Manual send failed',
    'job.manual.partial': 'Manual send partially sent',
    'whatsapp.disconnected': 'WhatsApp disconnected'
};

function notificationEventChecks(provider, events, allowed) {
    return allowed.map((event) => `
        <label class="notification-event">
            <input type="checkbox" data-notification-event="${provider}" value="${event}" ${events.includes(event) ? 'checked' : ''}>
            <span>${escapeHtml(notificationEventLabels[event])}</span>
        </label>
    `).join('');
}

function renderNotifications() {
    const config = state.notifications;
    if (!config) {
        notificationsEl.innerHTML = '<div class="empty">Loading notifications…</div>';
        return;
    }
    const whatsappRecipients = '<option value="">Select recipient</option>' + state.recipients.map((recipient) => `
        <option value="${escapeHtml(recipient.key)}" ${recipient.key === config.whatsapp.recipientKey ? 'selected' : ''}>
            ${escapeHtml(recipient.name)} · ${escapeHtml(recipient.maskedNumber)}
        </option>
    `).join('');

    const topicRecipientKey = config.whatsapp.recipientKey
        || state.recipients.find((recipient) => recipient.name === 'SELF')?.key
        || state.recipients[0]?.key
        || '';
    const topicRecipients = '<option value="">Select recipient</option>' + state.recipients.map((recipient) => `
        <option value="${escapeHtml(recipient.key)}" ${recipient.key === topicRecipientKey ? 'selected' : ''}>
            ${escapeHtml(recipient.name)} · ${escapeHtml(recipient.maskedNumber)}
        </option>
    `).join('');

    notificationsEl.innerHTML = `
        <article class="notification-card">
            <div class="notification-head">
                <div><strong>WhatsApp</strong><div class="muted">Confirmation in your own WhatsApp</div></div>
                <label class="switch-field"><span>Enabled</span><input id="notify-whatsapp-enabled" type="checkbox" ${config.whatsapp.enabled ? 'checked' : ''}></label>
            </div>
            <label>Send to<select id="notify-whatsapp-recipient">${whatsappRecipients}</select></label>
            <label class="notification-event notification-option">
                <input id="notify-whatsapp-include-message" type="checkbox" ${config.whatsapp.includeMessage ? 'checked' : ''}>
                <span>Include message body</span>
            </label>
            <div class="notification-events">
                ${notificationEventChecks('whatsapp', config.whatsapp.events, [
                    'job.completed', 'job.failed', 'job.partial',
                    'job.catchup.started', 'job.retry.scheduled', 'job.recovered', 'job.retry.exhausted',
                    'job.manual.completed', 'job.manual.failed', 'job.manual.partial'
                ])}
            </div>
            <button data-test-notification="whatsapp">Send test</button>
        </article>
        <article class="notification-card">
            <div class="notification-head">
                <div><strong>Push · ntfy</strong><div class="muted">Independent phone push channel</div></div>
                <label class="switch-field"><span>Enabled</span><input id="notify-ntfy-enabled" type="checkbox" ${config.ntfy.enabled ? 'checked' : ''}></label>
            </div>
            <label>Server<input id="notify-ntfy-server" value="${escapeHtml(config.ntfy.server)}"></label>
            <label>Topic<input id="notify-ntfy-topic" type="password" placeholder="${config.ntfy.topicConfigured ? `Configured · ${escapeHtml(config.ntfy.maskedTopic)}` : 'Long random ntfy topic'}"></label>
            <div class="muted notification-hint">Install the ntfy app on the phone and subscribe to this exact topic. A successful test confirms publication to ntfy, not phone delivery.</div>
            <label>Send topic to WhatsApp<select id="notify-ntfy-topic-recipient" data-notification-local>${topicRecipients}</select></label>
            <button type="button" data-send-ntfy-topic>Send topic to WhatsApp</button>
            <label class="notification-event notification-option">
                <input id="notify-ntfy-include-message" type="checkbox" ${config.ntfy.includeMessage ? 'checked' : ''}>
                <span>Include message body</span>
            </label>
            <div class="notification-events">
                ${notificationEventChecks('ntfy', config.ntfy.events, [
                    'job.completed', 'job.failed', 'job.partial',
                    'job.catchup.started', 'job.retry.scheduled', 'job.recovered', 'job.retry.exhausted',
                    'job.manual.completed', 'job.manual.failed', 'job.manual.partial',
                    'whatsapp.disconnected'
                ])}
            </div>
            <button data-test-notification="ntfy">Send test</button>
        </article>
        <div class="notification-actions">
            <p id="notification-error" class="error"></p>
        </div>
    `;
}

function selectedNotificationEvents(provider) {
    return [...document.querySelectorAll(`[data-notification-event="${provider}"]:checked`)].map((input) => input.value);
}

function notificationFormReady() {
    return Boolean($('#notify-whatsapp-enabled') && $('#notify-ntfy-enabled'));
}

function notificationBody() {
    return {
        whatsapp: {
            enabled: $('#notify-whatsapp-enabled').checked,
            recipientKey: $('#notify-whatsapp-recipient').value,
            includeMessage: $('#notify-whatsapp-include-message').checked,
            events: selectedNotificationEvents('whatsapp')
        },
        ntfy: {
            enabled: $('#notify-ntfy-enabled').checked,
            server: $('#notify-ntfy-server').value,
            topic: $('#notify-ntfy-topic').value,
            includeMessage: $('#notify-ntfy-include-message').checked,
            events: selectedNotificationEvents('ntfy')
        }
    };
}

function setNotificationSaveStatus(status, message = '') {
    const indicator = $('#notification-save-status');
    if (indicator) {
        indicator.className = `notification-save-status ${status}`;
        indicator.textContent = status === 'saving' ? 'Saving…'
            : status === 'failed' ? 'Save failed'
                : 'Saved ✓';
    }
    const error = $('#notification-error');
    if (error) error.textContent = message;
}

function markNotificationDirty() {
    notificationSave.dirty = true;
    notificationSave.revision += 1;
    setNotificationSaveStatus('saving');
}

async function saveNotifications({ allowRetry = true } = {}) {
    if (!notificationFormReady()) return state.notifications;
    if (notificationSave.saving) {
        await notificationSave.saving;
        if (!notificationSave.dirty) return state.notifications;
    }

    clearTimeout(notificationSave.timer);
    notificationSave.timer = null;
    const revision = notificationSave.revision;
    const body = notificationBody();
    notificationSave.dirty = false;
    setNotificationSaveStatus('saving');

    const request = api('/api/notifications', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    notificationSave.saving = request;

    try {
        state.notifications = await request;
        notificationSave.retryRevision = null;
        if (notificationSave.revision === revision && !notificationSave.dirty) {
            setNotificationSaveStatus('saved');
        }
        return state.notifications;
    } catch (error) {
        notificationSave.dirty = true;
        setNotificationSaveStatus('failed', error.message);
        if (allowRetry && notificationSave.retryRevision !== revision) {
            notificationSave.retryRevision = revision;
            notificationSave.retryTimer = setTimeout(() => {
                notificationSave.retryTimer = null;
                void saveNotifications({ allowRetry: false });
            }, 3000);
        }
        throw error;
    } finally {
        if (notificationSave.saving === request) notificationSave.saving = null;
    }
}

function queueNotificationSave(delay = 600) {
    if (!notificationFormReady()) return;
    markNotificationDirty();
    clearTimeout(notificationSave.timer);
    notificationSave.timer = setTimeout(() => {
        notificationSave.timer = null;
        saveNotifications().catch(() => {});
    }, delay);
}

async function flushNotificationSave() {
    clearTimeout(notificationSave.timer);
    notificationSave.timer = null;
    clearTimeout(notificationSave.retryTimer);
    notificationSave.retryTimer = null;
    if (notificationSave.saving) await notificationSave.saving.catch(() => {});
    if (notificationSave.dirty) await saveNotifications();
}

function activityMatchesFilter(event) {
    if (state.activityFilter === 'all') return true;
    if (state.activityFilter === 'jobs') return event.type.startsWith('job.');
    if (state.activityFilter === 'whatsapp') return event.type.startsWith('whatsapp.');
    if (state.activityFilter === 'errors') return event.level === 'error';
    return true;
}

function activityTime(timestamp) {
    return new Intl.DateTimeFormat([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    }).format(new Date(timestamp));
}

function renderActivity() {
    const events = state.activity.filter(activityMatchesFilter);
    activityEl.innerHTML = events.length ? events.map((event) => `
        <article class="activity-row ${escapeHtml(event.level)}">
            <time datetime="${escapeHtml(event.timestamp)}">${escapeHtml(activityTime(event.timestamp))}</time>
            <span class="activity-dot" aria-hidden="true"></span>
            <div class="activity-copy">
                <div class="activity-line">
                    ${event.jobId ? `<strong>${escapeHtml(event.jobId)}</strong>` : `<strong>${escapeHtml(event.type.replace(/\./g, ' '))}</strong>`}
                </div>
                <div class="activity-message">${escapeHtml(event.message)}</div>
            </div>
        </article>
    `).join('') : '<div class="empty">No activity yet.</div>';
}

async function loadActivity() {
    state.activity = await api(`/api/activity?limit=100&filter=${encodeURIComponent(state.activityFilter)}`);
    renderActivity();
}

function renderJobs() {
    jobsEl.innerHTML = state.jobs.length ? state.jobs.map((job) => `
        <article class="job ${job.enabled ? '' : 'disabled'}">
            <div class="job-head">
                <div>
                    <div class="job-title">${escapeHtml(job.id)} ${job.enabled ? '' : '<span class="paused">Paused</span>'}</div>
                    <div class="job-schedule">${escapeHtml(scheduleLabel(job.schedule))} · ${escapeHtml(job.recipientKey.replace('WA_RECIPIENT_', ''))}</div>
                    <div class="job-runtime">${job.enabled && job.nextRun ? `Next: ${escapeHtml(formatDateTime(job.nextRun))}` : 'Next: paused'} · ${escapeHtml(lastRunLabel(job.lastRun))}</div>
                </div>
            </div>
            ${job.message ? `<div class="job-message">${escapeHtml(job.message)}</div>` : ''}
            <div class="file-list">${job.files.map((file) => `<span class="file-chip">${escapeHtml(file.path.split('/').pop())}${file.caption ? ` · ${escapeHtml(file.caption)}` : ''}</span>`).join('')}</div>
            <div class="job-actions">
                <button data-send="${escapeHtml(job.id)}">Send now</button>
                <button data-toggle="${escapeHtml(job.id)}">${job.enabled ? 'Disable' : 'Enable'}</button>
                <button data-edit="${escapeHtml(job.id)}">Edit</button>
                <button class="danger" data-delete="${escapeHtml(job.id)}">Delete</button>
            </div>
        </article>
    `).join('') : '<div class="empty">No jobs configured.</div>';
}

function renderRecipients() {
    recipientsEl.innerHTML = state.recipients.length ? state.recipients.map((recipient) => `
        <div class="recipient">
            <div><div class="recipient-name">${escapeHtml(recipient.name)}</div><div class="recipient-number">${escapeHtml(recipient.maskedNumber)}</div></div>
            <button class="danger" data-delete-recipient="${escapeHtml(recipient.key)}">Delete</button>
        </div>
    `).join('') : '<div class="empty">No recipients configured.</div>';
}

async function refresh() {
    const [jobs, recipients, status, notifications] = await Promise.all([
        api('/api/jobs'), api('/api/recipients'), api('/api/status'), api('/api/notifications')
    ]);
    state.jobs = jobs.jobs;
    state.timezone = jobs.timezone;
    state.recipients = recipients;
    state.notifications = notifications;
    const since = status.startedAt ? ` · running since ${formatDateTime(status.startedAt)}` : '';
    $('#summary').textContent = `${status.activeJobs}/${jobs.jobs.length} active · ${jobs.timezone}${since}`;
    $('#wa-status').textContent = status.whatsapp;
    $('#wa-status').className = `status ${status.whatsapp}`;
    $('#activity-retention').textContent = `Keeping ${status.activityRetentionDays} days`;
    renderJobs();
    renderRecipients();
    renderNotifications();
    await loadActivity();
}

function renderRecipientOptions(selected = '') {
    $('#job-recipient').innerHTML = '<option value="">Select recipient</option>' + state.recipients.map((recipient) =>
        `<option value="${recipient.key}" ${recipient.key === selected ? 'selected' : ''}>${escapeHtml(recipient.name)} · ${escapeHtml(recipient.maskedNumber)}</option>`
    ).join('');
}

function cronToForm(value) {
    const parts = value.trim().split(/\s+/);
    if (parts.length !== 5) return { mode: 'advanced', cron: value };
    const [minute, hour, monthDay, month, weekDay] = parts;
    const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    if (monthDay === '*' && month === '*' && weekDay === '*') return { mode: 'daily', time };
    if (monthDay === '*' && month === '*' && /^\d$/.test(weekDay)) return { mode: 'weekly', time, weekday: weekDay };
    if (/^\d{1,2}$/.test(monthDay) && month === '*' && weekDay === '*') return { mode: 'monthly', time, monthday: monthDay };
    return { mode: 'advanced', cron: value };
}

function formToCron() {
    const mode = $('#schedule-mode').value;
    if (mode === 'advanced') return $('#cron').value.trim();
    const [hour, minute] = $('#schedule-time').value.split(':');
    if (mode === 'daily') return `${Number(minute)} ${Number(hour)} * * *`;
    if (mode === 'weekly') return `${Number(minute)} ${Number(hour)} * * ${$('#weekday').value}`;
    return `${Number(minute)} ${Number(hour)} ${Number($('#monthday').value)} * *`;
}

function updateRetryFields() {
    $('#job-retry-fields').hidden = !$('#job-retry-enabled').checked;
}

function updateScheduleFields() {
    const mode = $('#schedule-mode').value;
    $('#weekday-wrap').hidden = mode !== 'weekly';
    $('#monthday-wrap').hidden = mode !== 'monthly';
    $('#time-wrap').hidden = mode === 'advanced';
    $('#cron-wrap').hidden = mode !== 'advanced';
}

function renderFiles() {
    $('#job-files').innerHTML = state.editingFiles.map((file, index) => `
        <div class="file-row">
            <code title="${escapeHtml(file.path)}">${escapeHtml(file.path)}</code>
            <input data-caption="${index}" value="${escapeHtml(file.caption || '')}" placeholder="Caption (optional)">
            <button type="button" class="danger" data-remove-file="${index}">×</button>
        </div>
    `).join('') || '<div class="empty">No files attached.</div>';
}

function openJob(job = null) {
    $('#job-form').reset();
    $('#job-error').textContent = '';
    $('#original-id').value = job?.id || '';
    $('#job-title').textContent = job ? 'Edit job' : 'Add job';
    $('#job-id').value = job?.id || '';
    $('#job-enabled').checked = job?.enabled !== false;
    $('#job-message').value = job?.message || '';
    $('#job-retry-enabled').checked = Number(job?.retry?.attempts || 0) > 0;
    $('#job-retry-attempts').value = job?.retry?.attempts || 5;
    $('#job-retry-delay').value = job?.retry?.delayMinutes || 10;
    renderRecipientOptions(job?.recipientKey || '');
    state.editingFiles = structuredClone(job?.files || []);
    const schedule = cronToForm(job?.schedule || '0 8 * * *');
    $('#schedule-mode').value = schedule.mode;
    $('#schedule-time').value = schedule.time || '08:00';
    $('#weekday').value = schedule.weekday || '1';
    $('#monthday').value = schedule.monthday || '1';
    $('#cron').value = schedule.cron || '';
    updateScheduleFields();
    updateRetryFields();
    renderFiles();
    jobDialog.showModal();
}

$('#weekday').innerHTML = weekdays.map((day, index) => `<option value="${index}">${day}</option>`).join('');
$('#schedule-mode').addEventListener('change', updateScheduleFields);
$('#job-retry-enabled').addEventListener('change', updateRetryFields);
$('#add-job').addEventListener('click', () => openJob());
$('#add-recipient').addEventListener('click', () => {
    $('#recipient-form').reset();
    $('#recipient-error').textContent = '';
    recipientDialog.showModal();
});

document.addEventListener('click', async (event) => {
    if (event.target.matches('[data-close]')) event.target.closest('dialog').close();
    if (event.target.dataset.edit) openJob(state.jobs.find((job) => job.id === event.target.dataset.edit));
    if (event.target.dataset.removeFile !== undefined) {
        state.editingFiles.splice(Number(event.target.dataset.removeFile), 1);
        renderFiles();
    }
    if (event.target.dataset.sendNtfyTopic !== undefined) {
        event.target.disabled = true;
        try {
            await flushNotificationSave();
            const result = await api('/api/notifications/ntfy/topic/send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ recipientKey: $('#notify-ntfy-topic-recipient').value })
            });
            toast(result.message || 'ntfy topic sent to WhatsApp');
        } catch (error) {
            $('#notification-error').textContent = error.message;
        } finally {
            event.target.disabled = false;
        }
    }
    if (event.target.dataset.testNotification) {
        event.target.disabled = true;
        const provider = event.target.dataset.testNotification;
        try {
            const enabled = $(`#notify-${provider}-enabled`);
            if (enabled && !enabled.checked) {
                enabled.checked = true;
                queueNotificationSave(0);
            }
            await flushNotificationSave();
            const result = await api(`/api/notifications/test/${encodeURIComponent(provider)}`, { method: 'POST' });
            toast(result.message || 'Test notification sent');
        } catch (error) { $('#notification-error').textContent = error.message; }
        finally { event.target.disabled = false; }
    }
    if (event.target.dataset.send) {
        event.target.disabled = true;
        try { await api(`/api/jobs/${encodeURIComponent(event.target.dataset.send)}/send`, { method: 'POST' }); toast('Job sent'); }
        catch (error) { toast(error.message); }
        finally { event.target.disabled = false; }
    }
    if (event.target.dataset.toggle) {
        event.target.disabled = true;
        try {
            const result = await api(`/api/jobs/${encodeURIComponent(event.target.dataset.toggle)}/toggle`, { method: 'POST' });
            await refresh();
            toast(result.enabled ? 'Job enabled' : 'Job disabled');
        } catch (error) { toast(error.message); }
        finally { event.target.disabled = false; }
    }
    if (event.target.dataset.delete && confirm(`Delete ${event.target.dataset.delete}?`)) {
        try { await api(`/api/jobs/${encodeURIComponent(event.target.dataset.delete)}`, { method: 'DELETE' }); await refresh(); toast('Job deleted'); }
        catch (error) { toast(error.message); }
    }
    if (event.target.dataset.deleteRecipient && confirm('Delete this recipient?')) {
        try { await api(`/api/recipients/${encodeURIComponent(event.target.dataset.deleteRecipient)}`, { method: 'DELETE' }); await refresh(); toast('Recipient deleted'); }
        catch (error) { toast(error.message); }
    }
});


notificationsEl.addEventListener('change', (event) => {
    if (!event.target.closest('.notification-card') || event.target.dataset.notificationLocal !== undefined) return;
    queueNotificationSave(0);
});

notificationsEl.addEventListener('input', (event) => {
    if (!event.target.matches('#notify-ntfy-server, #notify-ntfy-topic')) return;
    queueNotificationSave(600);
});

window.addEventListener('beforeunload', (event) => {
    if (!notificationSave.dirty) return;
    event.preventDefault();
    event.returnValue = '';
});

$('#job-files').addEventListener('input', (event) => {
    if (event.target.dataset.caption !== undefined) {
        state.editingFiles[Number(event.target.dataset.caption)].caption = event.target.value;
    }
});

$('#file-input').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const form = new FormData();
    form.append('file', file);
    try {
        const uploaded = await api('/api/files', { method: 'POST', body: form });
        state.editingFiles.push({ path: uploaded.path, caption: '' });
        renderFiles();
        toast('File added');
    } catch (error) {
        $('#job-error').textContent = error.message;
    } finally {
        event.target.value = '';
    }
});

$('#job-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const originalId = $('#original-id').value;
    const body = {
        id: $('#job-id').value,
        enabled: $('#job-enabled').checked,
        schedule: formToCron(),
        retryEnabled: $('#job-retry-enabled').checked,
        retryAttempts: Number($('#job-retry-attempts').value),
        retryDelayMinutes: Number($('#job-retry-delay').value),
        recipientKey: $('#job-recipient').value,
        message: $('#job-message').value,
        files: state.editingFiles
    };
    try {
        await api(originalId ? `/api/jobs/${encodeURIComponent(originalId)}` : '/api/jobs', {
            method: originalId ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        jobDialog.close();
        await refresh();
        toast('Job saved');
    } catch (error) {
        $('#job-error').textContent = error.message;
    }
});

$('#recipient-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
        await api('/api/recipients', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: $('#recipient-name').value, number: $('#recipient-number').value })
        });
        recipientDialog.close();
        await refresh();
        toast('Recipient saved');
    } catch (error) {
        $('#recipient-error').textContent = error.message;
    }
});

refresh().catch((error) => toast(error.message));


$('#activity-filter').addEventListener('change', async (event) => {
    state.activityFilter = event.target.value;
    try { await loadActivity(); } catch (error) { toast(error.message); }
});

$('#clear-activity').addEventListener('click', async () => {
    if (!confirm('Clear activity log?')) return;
    try {
        await api('/api/activity', { method: 'DELETE' });
        state.activity = [];
        renderActivity();
        toast('Activity cleared');
    } catch (error) {
        toast(error.message);
    }
});

const activityStream = new EventSource('/api/activity/stream');
activityStream.onmessage = (event) => {
    const activity = JSON.parse(event.data);
    state.activity = [activity, ...state.activity.filter((item) => item.id !== activity.id)].slice(0, 100);
    renderActivity();
};
activityStream.addEventListener('clear', () => {
    state.activity = [];
    renderActivity();
});

setInterval(() => api('/api/status').then((status) => {
    $('#wa-status').textContent = status.whatsapp;
    $('#wa-status').className = `status ${status.whatsapp}`;
}).catch(() => {}), 5000);
