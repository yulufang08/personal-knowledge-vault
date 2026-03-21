import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import * as path from 'path';
import * as crypto from 'crypto';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import axios from 'axios';

dotenv.config();

const app: Express = express();
const port = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Database connection pool
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    })
  : new Pool({
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || 'postgres',
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432'),
      database: process.env.DB_NAME || 'knowledge_vault',
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

// ===== ENCRYPTION HELPERS =====
const AI_ENC_KEY = process.env.AI_KEY_ENCRYPTION_SECRET || crypto.randomBytes(32).toString('hex');

function encryptKey(plain: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(AI_ENC_KEY.substring(0, 64), 'hex'), iv);
  let enc = cipher.update(plain, 'utf8', 'hex');
  enc += cipher.final('hex');
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${enc}`;
}

function decryptKey(cipher: string): string {
  const [ivH, tagH, enc] = cipher.split(':');
  const dec = crypto.createDecipheriv('aes-256-gcm', Buffer.from(AI_ENC_KEY.substring(0, 64), 'hex'), Buffer.from(ivH, 'hex'));
  dec.setAuthTag(Buffer.from(tagH, 'hex'));
  let plain = dec.update(enc, 'hex', 'utf8');
  plain += dec.final('utf8');
  return plain;
}

// ===== CONSTANTS =====
const GUEST_USER_ID = '00000000-0000-0000-0000-000000000001';
const FREE_NOTE_LIMIT = 50;
const FREE_ANALYSIS_DAILY_LIMIT = 3;
const PRO_ANALYSIS_DAILY_LIMIT = 999;
const FREE_FILE_SIZE_LIMIT = 2 * 1024 * 1024; // 2MB
const PRO_FILE_SIZE_LIMIT = 50 * 1024 * 1024; // 50MB
const FREE_FILE_COUNT_LIMIT = 5;
const PRO_FILE_COUNT_LIMIT = 999;

// ===== DATABASE INIT =====
async function initializeDatabase() {
  try {
    const client = await pool.connect();

    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(255) UNIQUE NOT NULL,
        username VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        subscription VARCHAR(20) DEFAULT 'free',
        subscription_expires_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS notes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title VARCHAR(255) NOT NULL,
        content TEXT,
        description TEXT,
        markdown TEXT,
        is_favorited BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        deleted_at TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS tags (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        color VARCHAR(7),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, name)
      );

      CREATE TABLE IF NOT EXISTS note_tags (
        note_id UUID NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        tag_id UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        PRIMARY KEY (note_id, tag_id)
      );

      CREATE TABLE IF NOT EXISTS note_links (
        source_note_id UUID NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        target_note_id UUID NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (source_note_id, target_note_id)
      );

      CREATE TABLE IF NOT EXISTS note_versions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        note_id UUID NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        title VARCHAR(255),
        content TEXT NOT NULL,
        markdown TEXT NOT NULL,
        version_number INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS attachments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        note_id UUID NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        filename VARCHAR(255) NOT NULL,
        file_path VARCHAR(500) NOT NULL,
        file_size INT,
        mime_type VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS ai_analyses (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        source_type VARCHAR(20) NOT NULL,
        source_url TEXT,
        source_filename VARCHAR(255),
        original_content TEXT NOT NULL,
        summary TEXT,
        key_points JSONB DEFAULT '[]',
        highlights JSONB DEFAULT '[]',
        suggested_tags JSONB DEFAULT '[]',
        word_count INT DEFAULT 0,
        reading_time INT DEFAULT 0,
        file_size INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS sync_devices (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        device_name VARCHAR(255) NOT NULL,
        device_type VARCHAR(50) NOT NULL,
        device_id VARCHAR(255) NOT NULL,
        last_synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        is_current BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, device_id)
      );

      CREATE INDEX IF NOT EXISTS idx_notes_user_id ON notes(user_id);
      CREATE INDEX IF NOT EXISTS idx_notes_created_at ON notes(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tags_user_id ON tags(user_id);
      CREATE INDEX IF NOT EXISTS idx_note_tags_note_id ON note_tags(note_id);
      CREATE INDEX IF NOT EXISTS idx_note_tags_tag_id ON note_tags(tag_id);
      CREATE INDEX IF NOT EXISTS idx_note_links_source ON note_links(source_note_id);
      CREATE INDEX IF NOT EXISTS idx_note_links_target ON note_links(target_note_id);
      CREATE INDEX IF NOT EXISTS idx_note_versions_note ON note_versions(note_id, version_number DESC);
      CREATE TABLE IF NOT EXISTS user_ai_config (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider VARCHAR(50) NOT NULL,
        api_key_encrypted TEXT NOT NULL,
        api_key_hint VARCHAR(20),
        model VARCHAR(100),
        base_url VARCHAR(500),
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, provider)
      );

      CREATE TABLE IF NOT EXISTS agent_conversations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title VARCHAR(255) DEFAULT 'New Conversation',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS agent_messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        conversation_id UUID NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
        role VARCHAR(20) NOT NULL,
        content TEXT NOT NULL,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_ai_analyses_user ON ai_analyses(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sync_devices_user ON sync_devices(user_id);
      CREATE INDEX IF NOT EXISTS idx_ai_config_user ON user_ai_config(user_id);
      CREATE INDEX IF NOT EXISTS idx_agent_conv_user ON agent_conversations(user_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_msg_conv ON agent_messages(conversation_id, created_at);
    `);

    // Add subscription column if it doesn't exist (migration for existing DBs)
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription VARCHAR(20) DEFAULT 'free';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMP;
      ALTER TABLE notes ADD COLUMN IF NOT EXISTS is_favorited BOOLEAN DEFAULT false;
      ALTER TABLE note_versions ADD COLUMN IF NOT EXISTS title VARCHAR(255);
    `);

    // Create default guest user
    await client.query(`
      INSERT INTO users (id, email, username, password_hash, subscription)
      VALUES ('00000000-0000-0000-0000-000000000001', 'guest@example.com', 'guest', 'no-password', 'free')
      ON CONFLICT (id) DO NOTHING
    `);

    client.release();
    console.log('✅ Database schema initialized successfully');
  } catch (error) {
    console.error('❌ Database initialization error:', error);
    process.exit(1);
  }
}

// ===== AUTH MIDDLEWARE =====
const authenticateToken = (req: Request, _res: Response, next: any) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    req.user = { id: GUEST_USER_ID, email: 'guest@example.com' };
    return next();
  }

  jwt.verify(token, process.env.JWT_SECRET || 'secret-key', (err: any, user: any) => {
    if (err) {
      req.user = { id: GUEST_USER_ID, email: 'guest@example.com' };
      return next();
    }
    req.user = user;
    next();
  });
};

// Premium feature gate middleware
const requirePro = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;
    const result = await pool.query(
      `SELECT subscription, subscription_expires_at FROM users WHERE id = $1`,
      [userId]
    );
    if (result.rows.length === 0) {
      return res.status(403).json({ error: 'User not found', upgrade: true });
    }
    const user = result.rows[0];
    const isPro = user.subscription === 'pro' &&
      (!user.subscription_expires_at || new Date(user.subscription_expires_at) > new Date());
    if (!isPro) {
      return res.status(403).json({
        error: 'This feature requires a Pro subscription',
        upgrade: true,
        feature: 'pro'
      });
    }
    next();
  } catch (error) {
    res.status(500).json({ error: 'Failed to check subscription' });
  }
};

// ===== STATIC FILES =====
const publicPath = path.resolve(process.cwd(), 'public');
app.use(express.static(publicPath));

app.get('/', (_req: Request, res: Response) => {
  res.sendFile(path.join(publicPath, 'index.html'));
});

app.use(authenticateToken);

// ===== HEALTH & USER INFO =====
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Get user profile & subscription status
app.get('/api/user/profile', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const userResult = await pool.query(
      `SELECT id, email, username, subscription, subscription_expires_at, created_at FROM users WHERE id = $1`,
      [userId]
    );
    const noteCount = await pool.query(
      `SELECT COUNT(*) as count FROM notes WHERE user_id = $1 AND deleted_at IS NULL`,
      [userId]
    );
    const user = userResult.rows[0] || {};
    const isPro = user.subscription === 'pro' &&
      (!user.subscription_expires_at || new Date(user.subscription_expires_at) > new Date());
    res.json({
      data: {
        ...user,
        isPro,
        noteCount: parseInt(noteCount.rows[0].count),
        noteLimit: isPro ? null : FREE_NOTE_LIMIT,
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// Activate Pro subscription (demo: no real payment)
app.post('/api/user/upgrade', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const { plan } = req.body; // 'monthly' | 'yearly'
    const expiresAt = new Date();
    if (plan === 'yearly') {
      expiresAt.setFullYear(expiresAt.getFullYear() + 1);
    } else {
      expiresAt.setMonth(expiresAt.getMonth() + 1);
    }
    await pool.query(
      `UPDATE users SET subscription = 'pro', subscription_expires_at = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [expiresAt.toISOString(), userId]
    );
    res.json({ data: { subscription: 'pro', expires_at: expiresAt.toISOString() } });
  } catch (error) {
    res.status(500).json({ error: 'Failed to upgrade' });
  }
});

// Cancel subscription
app.post('/api/user/downgrade', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    await pool.query(
      `UPDATE users SET subscription = 'free', subscription_expires_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [userId]
    );
    res.json({ data: { subscription: 'free' } });
  } catch (error) {
    res.status(500).json({ error: 'Failed to downgrade' });
  }
});

// ===== NOTES CRUD =====
app.get('/api/notes', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const result = await pool.query(
      `SELECT id, title, description, is_favorited, created_at, updated_at FROM notes
       WHERE user_id = $1 AND deleted_at IS NULL
       ORDER BY updated_at DESC LIMIT 200`,
      [userId]
    );
    res.json({ data: result.rows });
  } catch (error) {
    console.error('Error fetching notes:', error);
    res.status(500).json({ error: 'Failed to fetch notes' });
  }
});

app.post('/api/notes', async (req: Request, res: Response) => {
  try {
    const { title, content, markdown, tags } = req.body;
    const userId = req.user?.id;
    const noteId = uuidv4();

    // Check free tier note limit
    const countResult = await pool.query(
      `SELECT COUNT(*) as count FROM notes WHERE user_id = $1 AND deleted_at IS NULL`,
      [userId]
    );
    const noteCount = parseInt(countResult.rows[0].count);
    const userResult = await pool.query(`SELECT subscription FROM users WHERE id = $1`, [userId]);
    const isPro = userResult.rows[0]?.subscription === 'pro';

    if (!isPro && noteCount >= FREE_NOTE_LIMIT) {
      return res.status(403).json({
        error: `Free plan is limited to ${FREE_NOTE_LIMIT} notes. Upgrade to Pro for unlimited notes.`,
        upgrade: true,
        limit: FREE_NOTE_LIMIT,
        current: noteCount
      });
    }

    const result = await pool.query(
      `INSERT INTO notes (id, user_id, title, content, markdown)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, title, created_at`,
      [noteId, userId, title || 'Untitled', content || '', markdown || '']
    );

    if (tags && Array.isArray(tags)) {
      for (const tagName of tags) {
        const tagResult = await pool.query(
          `INSERT INTO tags (user_id, name) VALUES ($1, $2)
           ON CONFLICT (user_id, name) DO UPDATE SET name = name RETURNING id`,
          [userId, tagName]
        );
        await pool.query(
          `INSERT INTO note_tags (note_id, tag_id) VALUES ($1, $2)`,
          [noteId, tagResult.rows[0].id]
        );
      }
    }

    res.status(201).json({ data: result.rows[0] });
  } catch (error) {
    console.error('Error creating note:', error);
    res.status(500).json({ error: 'Failed to create note' });
  }
});

app.get('/api/notes/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;

    const noteResult = await pool.query(
      `SELECT id, title, content, markdown, is_favorited, created_at, updated_at FROM notes
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [id, userId]
    );

    if (noteResult.rows.length === 0) {
      return res.status(404).json({ error: 'Note not found' });
    }

    const note = noteResult.rows[0];
    const tagsResult = await pool.query(
      `SELECT t.id, t.name, t.color FROM tags t
       INNER JOIN note_tags nt ON t.id = nt.tag_id WHERE nt.note_id = $1`,
      [id]
    );
    const linksResult = await pool.query(
      `SELECT target_note_id, title FROM note_links nl
       INNER JOIN notes n ON nl.target_note_id = n.id WHERE nl.source_note_id = $1`,
      [id]
    );

    res.json({ data: { ...note, tags: tagsResult.rows, links: linksResult.rows } });
  } catch (error) {
    console.error('Error fetching note:', error);
    res.status(500).json({ error: 'Failed to fetch note' });
  }
});

app.put('/api/notes/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { title, content, markdown, tags } = req.body;
    const userId = req.user?.id;

    // Save version before updating (for Pro users — always save, gate retrieval)
    const existing = await pool.query(
      `SELECT title, content, markdown FROM notes WHERE id = $1 AND user_id = $2`, [id, userId]
    );
    if (existing.rows.length > 0) {
      const versionCount = await pool.query(
        `SELECT COALESCE(MAX(version_number), 0) as max_v FROM note_versions WHERE note_id = $1`, [id]
      );
      const nextVersion = parseInt(versionCount.rows[0].max_v) + 1;
      await pool.query(
        `INSERT INTO note_versions (note_id, title, content, markdown, version_number)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, existing.rows[0].title, existing.rows[0].content || '', existing.rows[0].markdown || '', nextVersion]
      );
    }

    const result = await pool.query(
      `UPDATE notes SET title = $1, content = $2, markdown = $3, updated_at = CURRENT_TIMESTAMP
       WHERE id = $4 AND user_id = $5 RETURNING id, title, updated_at`,
      [title, content, markdown, id, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Note not found' });
    }

    if (tags && Array.isArray(tags)) {
      await pool.query(`DELETE FROM note_tags WHERE note_id = $1`, [id]);
      for (const tagName of tags) {
        const tagResult = await pool.query(
          `INSERT INTO tags (user_id, name) VALUES ($1, $2)
           ON CONFLICT (user_id, name) DO UPDATE SET name = name RETURNING id`,
          [userId, tagName]
        );
        await pool.query(
          `INSERT INTO note_tags (note_id, tag_id) VALUES ($1, $2)`,
          [id, tagResult.rows[0].id]
        );
      }
    }

    res.json({ data: result.rows[0] });
  } catch (error) {
    console.error('Error updating note:', error);
    res.status(500).json({ error: 'Failed to update note' });
  }
});

app.delete('/api/notes/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;
    const result = await pool.query(
      `UPDATE notes SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1 AND user_id = $2 RETURNING id`,
      [id, userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Note not found' });
    }
    res.json({ message: 'Note deleted successfully' });
  } catch (error) {
    console.error('Error deleting note:', error);
    res.status(500).json({ error: 'Failed to delete note' });
  }
});

// Toggle favorite
app.put('/api/notes/:id/favorite', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;
    const result = await pool.query(
      `UPDATE notes SET is_favorited = NOT COALESCE(is_favorited, false)
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
       RETURNING id, is_favorited`,
      [id, userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Note not found' });
    res.json({ data: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to toggle favorite' });
  }
});

// ===== TAGS =====
app.get('/api/tags', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const result = await pool.query(
      `SELECT id, name, color, COUNT(nt.note_id) as note_count
       FROM tags t LEFT JOIN note_tags nt ON t.id = nt.tag_id
       WHERE t.user_id = $1 GROUP BY t.id, t.name, t.color ORDER BY name`,
      [userId]
    );
    res.json({ data: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch tags' });
  }
});

// ===== SEARCH =====
app.get('/api/search', async (req: Request, res: Response) => {
  try {
    const { q } = req.query;
    const userId = req.user?.id;
    if (!q || typeof q !== 'string') return res.json({ data: [] });

    const searchQuery = `%${q}%`;
    const result = await pool.query(
      `SELECT id, title, description, created_at, updated_at FROM notes
       WHERE user_id = $1 AND deleted_at IS NULL
       AND (title ILIKE $2 OR content ILIKE $2 OR markdown ILIKE $2)
       ORDER BY updated_at DESC LIMIT 50`,
      [userId, searchQuery]
    );
    res.json({ data: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Failed to search notes' });
  }
});

// ===== KNOWLEDGE GRAPH =====
app.get('/api/graph', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const notesResult = await pool.query(
      `SELECT id, title FROM notes WHERE user_id = $1 AND deleted_at IS NULL LIMIT 500`,
      [userId]
    );
    const linksResult = await pool.query(
      `SELECT source_note_id, target_note_id FROM note_links
       WHERE source_note_id IN (SELECT id FROM notes WHERE user_id = $1 AND deleted_at IS NULL) LIMIT 1000`,
      [userId]
    );
    res.json({
      data: {
        nodes: notesResult.rows.map(n => ({ id: n.id, label: n.title })),
        edges: linksResult.rows.map(l => ({ from: l.source_note_id, to: l.target_note_id }))
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch graph' });
  }
});

// ===== PRO FEATURES =====

// Version history (Pro only)
app.get('/api/notes/:id/versions', requirePro, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;
    // Verify note ownership
    const noteCheck = await pool.query(
      `SELECT id FROM notes WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`, [id, userId]
    );
    if (noteCheck.rows.length === 0) return res.status(404).json({ error: 'Note not found' });

    const result = await pool.query(
      `SELECT id, version_number, title, created_at FROM note_versions
       WHERE note_id = $1 ORDER BY version_number DESC LIMIT 50`,
      [id]
    );
    res.json({ data: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch versions' });
  }
});

// Get specific version content (Pro only)
app.get('/api/notes/:id/versions/:versionId', requirePro, async (req: Request, res: Response) => {
  try {
    const { id, versionId } = req.params;
    const result = await pool.query(
      `SELECT * FROM note_versions WHERE id = $1 AND note_id = $2`,
      [versionId, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Version not found' });
    res.json({ data: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch version' });
  }
});

// Restore a version (Pro only)
app.post('/api/notes/:id/versions/:versionId/restore', requirePro, async (req: Request, res: Response) => {
  try {
    const { id, versionId } = req.params;
    const userId = req.user?.id;
    const version = await pool.query(
      `SELECT * FROM note_versions WHERE id = $1 AND note_id = $2`, [versionId, id]
    );
    if (version.rows.length === 0) return res.status(404).json({ error: 'Version not found' });

    const v = version.rows[0];
    await pool.query(
      `UPDATE notes SET title = COALESCE($1, title), content = $2, markdown = $3, updated_at = CURRENT_TIMESTAMP
       WHERE id = $4 AND user_id = $5`,
      [v.title, v.content, v.markdown, id, userId]
    );
    res.json({ data: { restored: true, version_number: v.version_number } });
  } catch (error) {
    res.status(500).json({ error: 'Failed to restore version' });
  }
});

// AI Summary (Pro only — simulated without actual AI API)
app.post('/api/pro/ai/summarize', requirePro, async (req: Request, res: Response) => {
  try {
    const { content } = req.body;
    if (!content) return res.status(400).json({ error: 'Content is required' });

    // Simulated AI summary — in production, call OpenAI/Claude API
    const sentences = content.replace(/[#*`>\-\[\]]/g, '').split(/[.!?。！？\n]+/).filter((s: string) => s.trim().length > 10);
    const summary = sentences.slice(0, 3).map((s: string) => s.trim()).join('. ');
    const wordCount = content.split(/\s+/).length;
    const keyPhrases = content.match(/\b[A-Z][a-z]+(?:\s[A-Z][a-z]+)*/g)?.slice(0, 5) || [];

    res.json({
      data: {
        summary: summary || 'This note contains brief content that doesn\'t require summarization.',
        wordCount,
        readingTime: Math.max(1, Math.ceil(wordCount / 200)),
        keyPhrases,
        suggestedTags: keyPhrases.slice(0, 3).map((p: string) => p.toLowerCase().replace(/\s+/g, '-')),
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'AI summarization failed' });
  }
});

// AI Smart Tag Suggestions (Pro only)
app.post('/api/pro/ai/suggest-tags', requirePro, async (req: Request, res: Response) => {
  try {
    const { content, title } = req.body;
    const text = `${title || ''} ${content || ''}`.toLowerCase();

    // Simulated tag suggestions based on content analysis
    const tagMap: Record<string, string[]> = {
      'code': ['javascript', 'python', 'function', 'class', 'import', 'const', 'let', 'var', 'api', 'http'],
      'design': ['ui', 'ux', 'color', 'layout', 'font', 'style', 'design', 'figma', 'wireframe'],
      'ideas': ['idea', 'brainstorm', 'concept', 'maybe', 'what if', 'could be', 'explore'],
      'meeting': ['meeting', 'agenda', 'attendees', 'action items', 'discuss', 'sync'],
      'learning': ['learn', 'tutorial', 'course', 'study', 'understand', 'concept', 'theory'],
      'project': ['project', 'milestone', 'deadline', 'sprint', 'task', 'roadmap', 'plan'],
      'personal': ['journal', 'diary', 'feeling', 'goal', 'habit', 'routine', 'reflection'],
      'research': ['research', 'paper', 'study', 'data', 'finding', 'analysis', 'result'],
    };

    const suggested: string[] = [];
    for (const [tag, keywords] of Object.entries(tagMap)) {
      if (keywords.some(kw => text.includes(kw))) suggested.push(tag);
    }

    res.json({ data: { tags: suggested.slice(0, 5) } });
  } catch (error) {
    res.status(500).json({ error: 'Tag suggestion failed' });
  }
});

// Advanced Graph Analytics (Pro only)
app.get('/api/pro/graph/analytics', requirePro, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;

    // Orphan notes (no links)
    const orphans = await pool.query(
      `SELECT n.id, n.title FROM notes n
       WHERE n.user_id = $1 AND n.deleted_at IS NULL
       AND n.id NOT IN (SELECT source_note_id FROM note_links)
       AND n.id NOT IN (SELECT target_note_id FROM note_links)
       ORDER BY n.updated_at DESC LIMIT 20`,
      [userId]
    );

    // Most connected notes (hubs)
    const hubs = await pool.query(
      `SELECT n.id, n.title,
        (SELECT COUNT(*) FROM note_links WHERE source_note_id = n.id OR target_note_id = n.id) as connections
       FROM notes n WHERE n.user_id = $1 AND n.deleted_at IS NULL
       ORDER BY connections DESC LIMIT 10`,
      [userId]
    );

    // Recently stale notes (not updated in 30+ days)
    const stale = await pool.query(
      `SELECT id, title, updated_at FROM notes
       WHERE user_id = $1 AND deleted_at IS NULL
       AND updated_at < NOW() - INTERVAL '30 days'
       ORDER BY updated_at ASC LIMIT 10`,
      [userId]
    );

    // Tag distribution
    const tagDist = await pool.query(
      `SELECT t.name, COUNT(nt.note_id) as count FROM tags t
       LEFT JOIN note_tags nt ON t.id = nt.tag_id
       WHERE t.user_id = $1 GROUP BY t.name ORDER BY count DESC LIMIT 15`,
      [userId]
    );

    // Writing streak (days with at least one note created/updated)
    const streak = await pool.query(
      `SELECT DATE(updated_at) as day, COUNT(*) as edits FROM notes
       WHERE user_id = $1 AND deleted_at IS NULL AND updated_at > NOW() - INTERVAL '30 days'
       GROUP BY DATE(updated_at) ORDER BY day DESC`,
      [userId]
    );

    res.json({
      data: {
        orphanNotes: orphans.rows,
        hubNotes: hubs.rows,
        staleNotes: stale.rows,
        tagDistribution: tagDist.rows,
        writingActivity: streak.rows,
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

// ===== AI ANALYSIS (Free: 3/day, 2MB, 5 files | Pro: unlimited, 50MB, unlimited) =====

// Helper: get user tier limits
async function getUserLimits(userId: string) {
  const r = await pool.query(`SELECT subscription, subscription_expires_at FROM users WHERE id = $1`, [userId]);
  const user = r.rows[0] || {};
  const isPro = user.subscription === 'pro' &&
    (!user.subscription_expires_at || new Date(user.subscription_expires_at) > new Date());
  return {
    isPro,
    dailyLimit: isPro ? PRO_ANALYSIS_DAILY_LIMIT : FREE_ANALYSIS_DAILY_LIMIT,
    fileSizeLimit: isPro ? PRO_FILE_SIZE_LIMIT : FREE_FILE_SIZE_LIMIT,
    fileCountLimit: isPro ? PRO_FILE_COUNT_LIMIT : FREE_FILE_COUNT_LIMIT,
  };
}

// Check daily analysis usage
async function getDailyUsage(userId: string) {
  const r = await pool.query(
    `SELECT COUNT(*) as count FROM ai_analyses WHERE user_id = $1 AND created_at > NOW() - INTERVAL '1 day'`,
    [userId]
  );
  return parseInt(r.rows[0].count);
}

// Simulated AI analysis — replace with real API later
function analyzeContent(text: string) {
  const sentences = text.replace(/[#*`>\-\[\]]/g, '').split(/[.!?。！？\n]+/).filter((s: string) => s.trim().length > 8);
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const charCount = text.length;

  // Extract key points (top sentences by length & keyword density)
  const keyPoints = sentences
    .map((s: string) => s.trim())
    .filter((s: string) => s.length > 20)
    .slice(0, 6)
    .map((s: string, i: number) => ({ id: i, text: s, importance: Math.max(0.5, 1 - i * 0.1) }));

  // Extract highlight phrases (capitalized phrases, quoted text, bold patterns)
  const highlights: { text: string; type: string }[] = [];
  const capitalPhrases = text.match(/\b[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)+/g) || [];
  capitalPhrases.slice(0, 8).forEach(p => highlights.push({ text: p, type: 'entity' }));
  const quotedText = text.match(/"([^"]+)"/g) || [];
  quotedText.slice(0, 4).forEach(q => highlights.push({ text: q.replace(/"/g, ''), type: 'quote' }));
  const boldText = text.match(/\*\*([^*]+)\*\*/g) || [];
  boldText.slice(0, 4).forEach(b => highlights.push({ text: b.replace(/\*\*/g, ''), type: 'emphasis' }));
  // Add some keyword-based highlights
  const importantWords = text.match(/\b(?:important|key|critical|essential|significant|notable|crucial|主要|重要|关键|核心|总结)[^.。!！?？\n]*/gi) || [];
  importantWords.slice(0, 3).forEach(w => highlights.push({ text: w.trim(), type: 'important' }));

  // Summary
  const summary = sentences.slice(0, 3).map((s: string) => s.trim()).join('. ') || 'Content is too brief for summarization.';

  // Tag suggestions
  const tagMap: Record<string, string[]> = {
    'tech': ['api', 'code', 'javascript', 'python', 'react', 'server', 'database', 'algorithm'],
    'design': ['ui', 'ux', 'color', 'layout', 'font', 'design', 'wireframe'],
    'business': ['revenue', 'growth', 'market', 'strategy', 'roi', 'customer', 'kpi'],
    'learning': ['learn', 'tutorial', 'course', 'study', 'concept', 'theory'],
    'research': ['research', 'paper', 'study', 'data', 'finding', 'analysis'],
    'news': ['announced', 'launch', 'update', 'release', 'report', 'news'],
    'personal': ['journal', 'diary', 'goal', 'habit', 'reflection'],
    'meeting': ['meeting', 'agenda', 'action items', 'discuss', 'sync'],
  };
  const lower = text.toLowerCase();
  const suggestedTags: string[] = [];
  for (const [tag, kws] of Object.entries(tagMap)) {
    if (kws.some(kw => lower.includes(kw))) suggestedTags.push(tag);
  }

  return {
    summary,
    keyPoints,
    highlights,
    suggestedTags: suggestedTags.slice(0, 5),
    wordCount,
    charCount,
    readingTime: Math.max(1, Math.ceil(wordCount / 200)),
  };
}

// POST /api/ai/analyze — analyze text, URL, or file content
app.post('/api/ai/analyze', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const { content, sourceType, sourceUrl, sourceFilename, fileSize } = req.body;
    // sourceType: 'text' | 'url' | 'file'

    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Content is required' });
    }

    const limits = await getUserLimits(userId);
    const dailyUsage = await getDailyUsage(userId);

    // Check daily limit
    if (dailyUsage >= limits.dailyLimit) {
      return res.json({
        error: `Daily analysis limit reached (${limits.dailyLimit}/day). ${limits.isPro ? '' : 'Upgrade to Pro for unlimited analyses.'}`,
        upgrade: !limits.isPro,
        limit: { daily: limits.dailyLimit, used: dailyUsage }
      });
    }

    // Check file size limit
    if (fileSize && fileSize > limits.fileSizeLimit) {
      const limitMB = limits.fileSizeLimit / (1024 * 1024);
      return res.json({
        error: `File exceeds ${limitMB}MB limit. ${limits.isPro ? '' : 'Upgrade to Pro for 50MB file support.'}`,
        upgrade: !limits.isPro,
      });
    }

    // Check file count limit for file type
    if (sourceType === 'file') {
      const fileCount = await pool.query(
        `SELECT COUNT(*) as count FROM ai_analyses WHERE user_id = $1 AND source_type = 'file'`,
        [userId]
      );
      if (parseInt(fileCount.rows[0].count) >= limits.fileCountLimit) {
        return res.json({
          error: `File analysis limit reached (${limits.fileCountLimit} files). ${limits.isPro ? '' : 'Upgrade to Pro for unlimited file analyses.'}`,
          upgrade: !limits.isPro,
        });
      }
    }

    // Run analysis
    const analysis = analyzeContent(content);

    // Save to DB
    const result = await pool.query(
      `INSERT INTO ai_analyses (user_id, source_type, source_url, source_filename, original_content, summary, key_points, highlights, suggested_tags, word_count, reading_time, file_size)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id, created_at`,
      [userId, sourceType || 'text', sourceUrl || null, sourceFilename || null, content,
       analysis.summary, JSON.stringify(analysis.keyPoints), JSON.stringify(analysis.highlights),
       JSON.stringify(analysis.suggestedTags), analysis.wordCount, analysis.readingTime, fileSize || 0]
    );

    res.json({
      data: {
        id: result.rows[0].id,
        ...analysis,
        sourceType,
        sourceUrl,
        sourceFilename,
        created_at: result.rows[0].created_at,
        usage: { daily: dailyUsage + 1, limit: limits.dailyLimit },
      }
    });
  } catch (error) {
    console.error('AI analysis error:', error);
    res.status(500).json({ error: 'Analysis failed' });
  }
});

// GET /api/ai/analyses — list past analyses
app.get('/api/ai/analyses', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const result = await pool.query(
      `SELECT id, source_type, source_url, source_filename, summary, key_points, highlights, suggested_tags, word_count, reading_time, file_size, created_at
       FROM ai_analyses WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [userId]
    );
    const limits = await getUserLimits(userId);
    const dailyUsage = await getDailyUsage(userId);
    res.json({
      data: result.rows,
      usage: { daily: dailyUsage, limit: limits.dailyLimit },
      limits: {
        isPro: limits.isPro,
        fileSizeLimit: limits.fileSizeLimit,
        fileCountLimit: limits.fileCountLimit,
        dailyLimit: limits.dailyLimit,
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch analyses' });
  }
});

// GET /api/ai/analyses/:id — get single analysis detail
app.get('/api/ai/analyses/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;
    const result = await pool.query(
      `SELECT * FROM ai_analyses WHERE id = $1 AND user_id = $2`, [id, userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Analysis not found' });
    res.json({ data: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch analysis' });
  }
});

// DELETE /api/ai/analyses/:id
app.delete('/api/ai/analyses/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;
    await pool.query(`DELETE FROM ai_analyses WHERE id = $1 AND user_id = $2`, [id, userId]);
    res.json({ message: 'Analysis deleted' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete analysis' });
  }
});

// Save analysis as note
app.post('/api/ai/analyses/:id/save-as-note', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;
    const analysis = await pool.query(
      `SELECT * FROM ai_analyses WHERE id = $1 AND user_id = $2`, [id, userId]
    );
    if (analysis.rows.length === 0) return res.status(404).json({ error: 'Analysis not found' });

    const a = analysis.rows[0];
    const keyPoints = (a.key_points || []).map((p: any) => `- ${p.text}`).join('\n');
    const tags = a.suggested_tags || [];
    const title = a.source_filename || (a.source_url ? 'From: ' + a.source_url.substring(0, 60) : 'AI Analysis');
    const markdown = `# ${title}\n\n## Summary\n${a.summary}\n\n## Key Points\n${keyPoints}\n\n---\n*Source: ${a.source_type}${a.source_url ? ' — ' + a.source_url : ''}*\n*Analyzed: ${new Date(a.created_at).toLocaleString()}*`;

    const noteId = uuidv4();
    const noteResult = await pool.query(
      `INSERT INTO notes (id, user_id, title, content, markdown) VALUES ($1, $2, $3, $4, $5) RETURNING id, title, created_at`,
      [noteId, userId, title, markdown, markdown]
    );

    // Add suggested tags
    for (const tagName of tags) {
      const tagResult = await pool.query(
        `INSERT INTO tags (user_id, name) VALUES ($1, $2) ON CONFLICT (user_id, name) DO UPDATE SET name = name RETURNING id`,
        [userId, tagName]
      );
      await pool.query(`INSERT INTO note_tags (note_id, tag_id) VALUES ($1, $2)`, [noteId, tagResult.rows[0].id]);
    }

    res.json({ data: noteResult.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save as note' });
  }
});

// ===== MULTI-DEVICE SYNC =====

// Register / update current device
app.post('/api/sync/device', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const { deviceName, deviceType, deviceId } = req.body;
    if (!deviceName || !deviceId) return res.status(400).json({ error: 'Device name and ID required' });

    // Unset current from all devices
    await pool.query(`UPDATE sync_devices SET is_current = false WHERE user_id = $1`, [userId]);

    // Upsert this device
    const result = await pool.query(
      `INSERT INTO sync_devices (user_id, device_name, device_type, device_id, is_current, last_synced_at)
       VALUES ($1, $2, $3, $4, true, CURRENT_TIMESTAMP)
       ON CONFLICT (user_id, device_id) DO UPDATE SET
         device_name = $2, device_type = $3, is_current = true, last_synced_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [userId, deviceName, deviceType || 'desktop', deviceId]
    );
    res.json({ data: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to register device' });
  }
});

// Get all synced devices
app.get('/api/sync/devices', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const result = await pool.query(
      `SELECT id, device_name, device_type, device_id, is_current, last_synced_at, created_at
       FROM sync_devices WHERE user_id = $1 ORDER BY last_synced_at DESC`,
      [userId]
    );
    res.json({ data: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch devices' });
  }
});

// Remove a device
app.delete('/api/sync/devices/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;
    await pool.query(`DELETE FROM sync_devices WHERE id = $1 AND user_id = $2`, [id, userId]);
    res.json({ message: 'Device removed' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to remove device' });
  }
});

// Sync status endpoint
app.get('/api/sync/status', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const devices = await pool.query(
      `SELECT COUNT(*) as count FROM sync_devices WHERE user_id = $1`, [userId]
    );
    const lastSync = await pool.query(
      `SELECT MAX(last_synced_at) as last_sync FROM sync_devices WHERE user_id = $1`, [userId]
    );
    const noteCount = await pool.query(
      `SELECT COUNT(*) as count FROM notes WHERE user_id = $1 AND deleted_at IS NULL`, [userId]
    );
    const limits = await getUserLimits(userId);
    res.json({
      data: {
        deviceCount: parseInt(devices.rows[0].count),
        lastSyncAt: lastSync.rows[0].last_sync,
        noteCount: parseInt(noteCount.rows[0].count),
        syncEnabled: limits.isPro || parseInt(devices.rows[0].count) <= 2,
        isPro: limits.isPro,
        maxDevices: limits.isPro ? 10 : 2,
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get sync status' });
  }
});

// ===== AI PROVIDER ABSTRACTION =====

async function getUserAIConfig(userId: string) {
  const r = await pool.query(
    `SELECT provider, api_key_encrypted, model, base_url FROM user_ai_config WHERE user_id = $1 AND is_active = true LIMIT 1`,
    [userId]
  );
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  try {
    return { provider: row.provider, apiKey: decryptKey(row.api_key_encrypted), model: row.model, baseUrl: row.base_url };
  } catch(e) { return null; }
}

async function callAIProvider(config: any, messages: any[]): Promise<{ content: string; model: string }> {
  const { provider, apiKey, model, baseUrl } = config;

  if (provider === 'claude' || provider === 'anthropic') {
    const r = await axios.post(baseUrl || 'https://api.anthropic.com/v1/messages', {
      model: model || 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      messages: messages.filter((m: any) => m.role !== 'system'),
      system: messages.find((m: any) => m.role === 'system')?.content || '',
    }, {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      timeout: 30000,
    });
    return { content: r.data.content?.[0]?.text || '', model: r.data.model || model };
  }

  // OpenAI-compatible (OpenAI, DeepSeek, custom)
  const url = baseUrl
    ? `${baseUrl}/chat/completions`
    : provider === 'deepseek'
      ? 'https://api.deepseek.com/v1/chat/completions'
      : 'https://api.openai.com/v1/chat/completions';

  const r = await axios.post(url, {
    model: model || 'gpt-4o-mini',
    messages,
    max_tokens: 2048,
  }, {
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    timeout: 30000,
  });
  return { content: r.data.choices?.[0]?.message?.content || '', model: r.data.model || model };
}

function simulateAgentResponse(message: string, userNotes: any[]): string {
  const lower = message.toLowerCase();
  if (lower.includes('how many') || lower.includes('多少') || lower.includes('count')) {
    return `You currently have **${userNotes.length}** notes in your vault.\n\n_[Simulated response — configure an AI provider in Settings for intelligent answers]_`;
  }
  if (lower.includes('recent') || lower.includes('最近') || lower.includes('latest')) {
    const recent = userNotes.slice(0, 5).map(n => `- "${n.title}"`).join('\n');
    return `Here are your most recent notes:\n${recent}\n\n_[Simulated — connect an AI provider for deeper analysis]_`;
  }
  const keywords = message.split(/[\s,，。.!?]+/).filter(w => w.length > 2);
  const matching = userNotes.filter(n =>
    keywords.some(kw => (n.title||'').toLowerCase().includes(kw.toLowerCase()) || (n.content||'').toLowerCase().includes(kw.toLowerCase()))
  );
  if (matching.length > 0) {
    const list = matching.slice(0, 5).map(n => `- **${n.title}**`).join('\n');
    return `I found ${matching.length} related note${matching.length>1?'s':''}:\n${list}\n\nWould you like me to analyze any of these?\n\n_[Simulated — configure an AI provider in Settings for real AI reasoning]_`;
  }
  return `I can help you explore your knowledge vault! Try asking about specific topics in your notes, or configure an AI provider in **Settings** for intelligent conversations.\n\n**Quick suggestions:**\n- "How many notes do I have?"\n- "What are my recent notes?"\n- "Find notes about [topic]"\n\n_[Simulated response]_`;
}

// ===== AI CONFIG ENDPOINTS =====

app.get('/api/ai/config', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const r = await pool.query(
      `SELECT id, provider, api_key_hint, model, base_url, is_active, updated_at FROM user_ai_config WHERE user_id = $1 ORDER BY is_active DESC`,
      [userId]
    );
    res.json({ data: r.rows });
  } catch(e) { res.status(500).json({ error: 'Failed to fetch AI config' }); }
});

app.post('/api/ai/config', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const { provider, apiKey, model, baseUrl } = req.body;
    if (!provider || !apiKey) return res.status(400).json({ error: 'Provider and API key required' });

    const encrypted = encryptKey(apiKey);
    const hint = '...' + apiKey.slice(-4);

    // Deactivate other providers
    await pool.query(`UPDATE user_ai_config SET is_active = false WHERE user_id = $1`, [userId]);

    const r = await pool.query(
      `INSERT INTO user_ai_config (user_id, provider, api_key_encrypted, api_key_hint, model, base_url, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, true)
       ON CONFLICT (user_id, provider) DO UPDATE SET
         api_key_encrypted = $3, api_key_hint = $4, model = $5, base_url = $6, is_active = true, updated_at = CURRENT_TIMESTAMP
       RETURNING id, provider, api_key_hint, model, base_url, is_active`,
      [userId, provider, encrypted, hint, model || null, baseUrl || null]
    );
    res.json({ data: r.rows[0] });
  } catch(e) {
    console.error('AI config save error:', e);
    res.status(500).json({ error: 'Failed to save AI config' });
  }
});

app.delete('/api/ai/config/:provider', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    await pool.query(`DELETE FROM user_ai_config WHERE user_id = $1 AND provider = $2`, [userId, req.params.provider]);
    res.json({ message: 'Config deleted' });
  } catch(e) { res.status(500).json({ error: 'Failed to delete config' }); }
});

app.post('/api/ai/config/test', async (req: Request, res: Response) => {
  try {
    const { provider, apiKey, model, baseUrl } = req.body;
    if (!provider || !apiKey) return res.status(400).json({ error: 'Provider and API key required' });

    const start = Date.now();
    const config = { provider, apiKey, model, baseUrl };
    const result = await callAIProvider(config, [
      { role: 'user', content: 'Say "Connection successful!" in exactly 3 words.' }
    ]);
    res.json({ data: { success: true, model: result.model, latency: Date.now() - start, response: result.content.substring(0, 100) } });
  } catch(e: any) {
    const msg = e.response?.data?.error?.message || e.message || 'Connection failed';
    res.json({ data: { success: false, error: msg } });
  }
});

// ===== AI AGENT ENDPOINTS =====

app.get('/api/agent/conversations', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const r = await pool.query(
      `SELECT c.id, c.title, c.created_at, c.updated_at,
        (SELECT COUNT(*) FROM agent_messages WHERE conversation_id = c.id) as message_count,
        (SELECT content FROM agent_messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message
       FROM agent_conversations c WHERE c.user_id = $1 ORDER BY c.updated_at DESC LIMIT 50`,
      [userId]
    );
    res.json({ data: r.rows });
  } catch(e) { res.status(500).json({ error: 'Failed to fetch conversations' }); }
});

app.post('/api/agent/conversations', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const r = await pool.query(
      `INSERT INTO agent_conversations (user_id) VALUES ($1) RETURNING id, title, created_at`,
      [userId]
    );
    res.json({ data: r.rows[0] });
  } catch(e) { res.status(500).json({ error: 'Failed to create conversation' }); }
});

app.get('/api/agent/conversations/:id', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const conv = await pool.query(
      `SELECT * FROM agent_conversations WHERE id = $1 AND user_id = $2`, [req.params.id, userId]
    );
    if (conv.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    const msgs = await pool.query(
      `SELECT id, role, content, metadata, created_at FROM agent_messages WHERE conversation_id = $1 ORDER BY created_at`,
      [req.params.id]
    );
    res.json({ data: { ...conv.rows[0], messages: msgs.rows } });
  } catch(e) { res.status(500).json({ error: 'Failed to fetch conversation' }); }
});

app.delete('/api/agent/conversations/:id', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    await pool.query(`DELETE FROM agent_conversations WHERE id = $1 AND user_id = $2`, [req.params.id, userId]);
    res.json({ message: 'Deleted' });
  } catch(e) { res.status(500).json({ error: 'Failed to delete' }); }
});

app.post('/api/agent/chat', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    let { conversationId, message } = req.body;
    if (!message) return res.status(400).json({ error: 'Message required' });

    // Create conversation if needed
    if (!conversationId) {
      const r = await pool.query(
        `INSERT INTO agent_conversations (user_id, title) VALUES ($1, $2) RETURNING id`,
        [userId, message.substring(0, 60)]
      );
      conversationId = r.rows[0].id;
    }

    // Save user message
    await pool.query(
      `INSERT INTO agent_messages (conversation_id, role, content) VALUES ($1, 'user', $2)`,
      [conversationId, message]
    );

    // Fetch user's notes for context
    const notesR = await pool.query(
      `SELECT id, title, content FROM notes WHERE user_id = $1 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 100`,
      [userId]
    );
    const userNotes = notesR.rows;

    // Search relevant notes by keywords
    const keywords = message.split(/[\s,，。.!?]+/).filter((w: string) => w.length > 2).slice(0, 5);
    let relevantNotes: any[] = [];
    if (keywords.length > 0) {
      const searchQ = keywords.map((kw: string) => `%${kw}%`);
      const conditions = searchQ.map((_: string, i: number) => `(title ILIKE $${i+2} OR content ILIKE $${i+2})`).join(' OR ');
      const rn = await pool.query(
        `SELECT id, title, SUBSTRING(content, 1, 1000) as content FROM notes WHERE user_id = $1 AND deleted_at IS NULL AND (${conditions}) LIMIT 5`,
        [userId, ...searchQ]
      );
      relevantNotes = rn.rows;
    }

    // Get conversation history
    const histR = await pool.query(
      `SELECT role, content FROM agent_messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [conversationId]
    );
    const history = histR.rows.reverse();

    // Try real AI provider
    const aiConfig = await getUserAIConfig(userId);
    let response: string;

    if (aiConfig) {
      const systemPrompt = `You are a helpful knowledge assistant for a personal note-taking app called "Vault". The user has ${userNotes.length} notes.
${relevantNotes.length > 0 ? `\nRelevant notes found:\n${relevantNotes.map(n => `--- ${n.title} ---\n${n.content}`).join('\n\n')}` : ''}
\nHelp the user explore, understand, and build on their knowledge. Reference specific notes when relevant. Be concise and insightful. Support both Chinese and English.`;

      const messages = [
        { role: 'system', content: systemPrompt },
        ...history.slice(-18).map((m: any) => ({ role: m.role, content: m.content })),
        { role: 'user', content: message }
      ];

      try {
        const result = await callAIProvider(aiConfig, messages);
        response = result.content;
      } catch(e: any) {
        response = `_AI provider error: ${e.response?.data?.error?.message || e.message}_\n\nFalling back to simulated response:\n\n${simulateAgentResponse(message, userNotes)}`;
      }
    } else {
      response = simulateAgentResponse(message, userNotes);
    }

    // Save assistant response
    await pool.query(
      `INSERT INTO agent_messages (conversation_id, role, content, metadata) VALUES ($1, 'assistant', $2, $3)`,
      [conversationId, response, JSON.stringify({ notesReferenced: relevantNotes.map(n => n.id) })]
    );

    // Update conversation timestamp
    await pool.query(
      `UPDATE agent_conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [conversationId]
    );

    res.json({
      data: {
        conversationId,
        message: response,
        notesReferenced: relevantNotes.map(n => ({ id: n.id, title: n.title })),
        provider: aiConfig ? aiConfig.provider : 'simulated',
      }
    });
  } catch(e) {
    console.error('Agent chat error:', e);
    res.status(500).json({ error: 'Chat failed' });
  }
});

// ===== ERROR HANDLING =====
app.use((err: any, _req: Request, res: Response, _next: any) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ===== START =====
async function start() {
  try {
    await initializeDatabase();
    app.listen(port, () => {
      console.log(`🚀 Server running on port ${port}`);
      console.log(`📚 API: http://localhost:${port}/api`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();

export default app;
