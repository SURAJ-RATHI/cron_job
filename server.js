require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 4000;

// MongoDB configuration
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/cron_job';
const DB_NAME = process.env.DB_NAME || 'cron_job';
const URLS_COLLECTION = process.env.URLS_COLLECTION || 'urls';

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

let mongoClient;
let urlsCollection;

async function initMongo() {
  if (urlsCollection) return urlsCollection;

  mongoClient = new MongoClient(MONGODB_URI);

  await mongoClient.connect();
  const db = mongoClient.db(DB_NAME);
  urlsCollection = db.collection(URLS_COLLECTION);

  console.log(`Connected to MongoDB database "${DB_NAME}", collection "${URLS_COLLECTION}"`);
  return urlsCollection;
}

// ----- REST API for managing URLs (used by the UI) -----

// List all stored URLs
app.get('/api/urls', async (req, res) => {
  try {
    const collection = await initMongo();
    const docs = await collection
      .find({})
      .sort({ createdAt: -1 })
      .toArray();

    const result = docs.map((doc) => ({
      id: doc._id.toString(),
      url: doc.url,
      active: doc.active !== false,
      createdAt: doc.createdAt,
      lastPingAt: doc.lastPingAt || null,
      lastStatus: doc.lastStatus || null,
      lastStatusCode: doc.lastStatusCode || null,
      nextPingAt: doc.nextPingAt || null,
    }));

    res.json(result);
  } catch (err) {
    console.error('Failed to list URLs:', err.message);
    res.status(500).json({ error: 'Failed to list URLs' });
  }
});

// Helper: ping a single URL document and update its status
async function pingSingleUrl(doc) {
  const collection = await initMongo();
  const url = (doc.url || '').trim();
  if (!url) return;

  const now = new Date();
  const nextPingAt = new Date(now.getTime() + FOURTEEN_MINUTES_MS);

  try {
    const res = await fetch(url, { method: 'GET' });
    console.log(`[PING] (single) OK ${res.status} - ${url}`);

    await collection.updateOne(
      { _id: doc._id },
      {
        $set: {
          lastPingAt: now,
          lastStatus: 'ok',
          lastStatusCode: res.status,
          nextPingAt,
        },
      },
    );
  } catch (err) {
    console.error(`[PING] (single) ERROR - ${url} - ${err.message}`);

    await collection.updateOne(
      { _id: doc._id },
      {
        $set: {
          lastPingAt: now,
          lastStatus: 'error',
          lastStatusCode: null,
          nextPingAt,
        },
      },
    );
  }
}

// Add a new URL
app.post('/api/urls', async (req, res) => {
  try {
    const { url } = req.body || {};

    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'Valid url is required' });
    }

    const normalizedUrl = url.trim();
    if (!normalizedUrl) {
      return res.status(400).json({ error: 'Valid url is required' });
    }

    const collection = await initMongo();

    const now = new Date();
    const insertResult = await collection.insertOne({
      url: normalizedUrl,
      active: true,
      createdAt: now,
      lastPingAt: null,
      lastStatus: null,
      lastStatusCode: null,
      nextPingAt: new Date(now.getTime() + FOURTEEN_MINUTES_MS),
    });

    // Immediately kick off a first ping in the background
    pingSingleUrl({ _id: insertResult.insertedId, url: normalizedUrl }).catch((err) => {
      console.error('Initial ping for new URL failed:', err.message);
    });

    res.status(201).json({
      id: insertResult.insertedId.toString(),
      url: normalizedUrl,
      active: true,
      createdAt: now,
    });
  } catch (err) {
    console.error('Failed to add URL:', err.message);
    res.status(500).json({ error: 'Failed to add URL' });
  }
});

// Remove a URL by id
app.delete('/api/urls/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ error: 'id is required' });
    }

    let objectId;
    try {
      objectId = new ObjectId(id);
    } catch {
      return res.status(400).json({ error: 'Invalid id' });
    }

    const collection = await initMongo();
    const result = await collection.deleteOne({ _id: objectId });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'URL not found' });
    }

    res.status(204).end();
  } catch (err) {
    console.error('Failed to remove URL:', err.message);
    res.status(500).json({ error: 'Failed to remove URL' });
  }
});

// Pings all URLs stored in MongoDB every 14 minutes.
// Documents are expected to look like: { _id, url: string, active?: boolean }
// Only documents with a valid string "url" and active !== false are used.
async function pingStoredUrls() {
  try {
    const collection = await initMongo();

    const docs = await collection
      .find({
        url: { $type: 'string' },
        $or: [{ active: { $exists: false } }, { active: { $ne: false } }],
      })
      .toArray();

    if (!docs.length) {
      console.log('[PING] No active URLs found in MongoDB to ping.');
      return;
    }

    console.log(`[PING] Starting ping cycle for ${docs.length} URL(s) at ${new Date().toISOString()}`);

    await Promise.all(
      docs.map(async (doc) => {
        const url = doc.url.trim();
        if (!url) return;

        const now = new Date();
        const nextPingAt = new Date(now.getTime() + FOURTEEN_MINUTES_MS);

        try {
          const res = await fetch(url, { method: 'GET' });
          console.log(`[PING] OK ${res.status} - ${url}`);

           await collection.updateOne(
             { _id: doc._id },
             {
               $set: {
                 lastPingAt: now,
                 lastStatus: 'ok',
                 lastStatusCode: res.status,
                 nextPingAt,
               },
             },
           );
        } catch (err) {
          console.error(`[PING] ERROR - ${url} - ${err.message}`);

          await collection.updateOne(
            { _id: doc._id },
            {
              $set: {
                lastPingAt: now,
                lastStatus: 'error',
                lastStatusCode: null,
                nextPingAt,
              },
            },
          );
        }
      }),
    );
  } catch (err) {
    console.error('[PING] Failed ping cycle:', err.message);
  }
}

// 14 minutes in milliseconds
const FOURTEEN_MINUTES_MS = 14 * 60 * 1000;

// Start the recurring job once the server is up.
app.listen(PORT, async () => {
  console.log(`Cron URL pinger running on port ${PORT}`);

  try {
    await initMongo();
  } catch (err) {
    console.error('Failed to initialize MongoDB connection:', err.message);
  }

  // Run immediately on startup
  pingStoredUrls().catch((err) => {
    console.error('Initial ping cycle failed:', err.message);
  });

  // Schedule every 14 minutes
  setInterval(() => {
    pingStoredUrls().catch((err) => {
      console.error('Scheduled ping cycle failed:', err.message);
    });
  }, FOURTEEN_MINUTES_MS);
});

