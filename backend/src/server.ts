import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import * as path from 'path';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

dotenv.config();

const app: Express = express();
const port = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());
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

// ===== CONSTANTS =====
const GUEST_USER_ID = '00000000-0000-0000-0000-000000000001';
const FREE_NOTE_LIMIT = 50;

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

      CREATE INDEX IF NOT EXISTS idx_notes_user_id ON notes(user_id);
      CREATE INDEX IF NOT EXISTS idx_notes_created_at ON notes(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tags_user_id ON tags(user_id);
      CREATE INDEX IF NOT EXISTS idx_note_tags_note_id ON note_tags(note_id);
      CREATE INDEX IF NOT EXISTS idx_note_tags_tag_id ON note_tags(tag_id);
      CREATE INDEX IF NOT EXISTS idx_note_links_source ON note_links(source_note_id);
      CREATE INDEX IF NOT EXISTS idx_note_links_target ON note_links(target_note_id);
      CREATE INDEX IF NOT EXISTS idx_note_versions_note ON note_versions(note_id, version_number DESC);
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
