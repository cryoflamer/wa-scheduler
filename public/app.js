const state = { jobs: [], recipients: [], timezone: '', editingFiles: [], activity: [], activityFilter: 'all' };
const $ = (selector) => document.querySelector(selector);
const jobsEl = $('#jobs');
const recipientsEl = $('#recipients');
const jobDialog = $('#job-dialog');
const recipientDialog = $('#recipient-dialog');
const activityEl = $('#activity');
const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

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
                : lastRun.status === 'running' ? 'Running' : lastRun.status;
    return `Last: ${status} · ${formatDateTime(lastRun.timestamp || `${lastRun.date}T00:00:00`)}`;
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
    const [jobs, recipients, status] = await Promise.all([
        api('/api/jobs'), api('/api/recipients'), api('/api/status')
    ]);
    state.jobs = jobs.jobs;
    state.timezone = jobs.timezone;
    state.recipients = recipients;
    const since = status.startedAt ? ` · running since ${formatDateTime(status.startedAt)}` : '';
    $('#summary').textContent = `${status.activeJobs}/${jobs.jobs.length} active · ${jobs.timezone}${since}`;
    $('#wa-status').textContent = status.whatsapp;
    $('#wa-status').className = `status ${status.whatsapp}`;
    renderJobs();
    renderRecipients();
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
    renderRecipientOptions(job?.recipientKey || '');
    state.editingFiles = structuredClone(job?.files || []);
    const schedule = cronToForm(job?.schedule || '0 8 * * *');
    $('#schedule-mode').value = schedule.mode;
    $('#schedule-time').value = schedule.time || '08:00';
    $('#weekday').value = schedule.weekday || '1';
    $('#monthday').value = schedule.monthday || '1';
    $('#cron').value = schedule.cron || '';
    updateScheduleFields();
    renderFiles();
    jobDialog.showModal();
}

$('#weekday').innerHTML = weekdays.map((day, index) => `<option value="${index}">${day}</option>`).join('');
$('#schedule-mode').addEventListener('change', updateScheduleFields);
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
