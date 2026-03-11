const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// In-memory store of jobs: { id, url, intervalMs, lastPing, status }
const jobs = new Map();
let nextId = 1;

function createJob(url, intervalMs) {
  const id = String(nextId++);
  const job = {
    id,
    url,
    intervalMs,
    lastPing: null,
    status: 'idle',
  };

  const tick = async () => {
    job.status = 'pinging';
    try {
      const res = await fetch(job.url, { method: 'GET' });
      job.lastPing = new Date().toISOString();
      job.status = `ok (${res.status})`;
    } catch (err) {
      job.lastPing = new Date().toISOString();
      job.status = 'error';
      console.error(`Error pinging ${job.url}:`, err.message);
    }
  };

  // Start interval
  const handle = setInterval(tick, intervalMs);
  job._timer = handle;

  // Fire first ping immediately so status is visible right away
  tick().catch((err) => {
    console.error(`Initial ping failed for ${job.url}:`, err.message);
  });

  jobs.set(id, job);
  return job;
}

function removeJob(id) {
  const job = jobs.get(id);
  if (!job) return false;
  if (job._timer) clearInterval(job._timer);
  jobs.delete(id);
  return true;
}

app.get('/api/jobs', (req, res) => {
  res.json(Array.from(jobs.values()).map(({ _timer, ...rest }) => rest));
});

app.post('/api/jobs', (req, res) => {
  const { url, intervalMinutes } = req.body || {};

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Valid url is required' });
  }

  const minutes = Number(intervalMinutes);
  if (!minutes || minutes <= 0) {
    return res.status(400).json({ error: 'intervalMinutes must be a positive number' });
  }

  const intervalMs = minutes * 60 * 1000;
  const job = createJob(url.trim(), intervalMs);
  res.status(201).json(job);
});

app.delete('/api/jobs/:id', (req, res) => {
  const { id } = req.params;
  const ok = removeJob(id);
  if (!ok) return res.status(404).json({ error: 'Job not found' });
  res.status(204).end();
});

app.listen(PORT, () => {
  console.log(`Cron URL pinger running on port ${PORT}`);
});

