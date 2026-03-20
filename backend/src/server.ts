import express, { Express, Request, Response } from 'express';
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

// Initialize database schema
async function initializeDatabase() {
  try {
    const client = await pool.connect();

    // Create tables
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(255) UNIQUE NOT NULL,
        username VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
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
    `);

    client.release();
    console.log('✅ Database schema initialized successfully');
  } catch (error) {
    console.error('❌ Database initialization error:', error);
    process.exit(1);
  }
}

// Authentication middleware
const authenticateToken = (req: Request, res: Response, next: any) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    // For demo purposes, create a guest user
    req.user = { id: 'guest-' + uuidv4(), email: 'guest@example.com' };
    return next();
  }

  jwt.verify(token, process.env.JWT_SECRET || 'secret-key', (err: any, user: any) => {
    if (err) {
      req.user = { id: 'guest-' + uuidv4(), email: 'guest@example.com' };
      return next();
    }
    req.user = user;
    next();
  });
};

// Serve static frontend (before auth middleware so it's publicly accessible)
const publicPath = path.resolve(process.cwd(), 'public');
app.use(express.static(publicPath));

// Fallback: serve index.html for SPA routing
app.get('/', (_req: Request, res: Response) => {
  res.sendFile(path.join(publicPath, 'index.html'));
});

app.use(authenticateToken);

// Health check
app.get('/api/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Get all notes
app.get('/api/notes', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const result = await pool.query(
      `SELECT id, title, description, created_at, updated_at FROM notes
       WHERE user_id = $1 AND deleted_at IS NULL
       ORDER BY updated_at DESC LIMIT 100`,
      [userId]
    );
    res.json({ data: result.rows });
  } catch (error) {
    console.error('Error fetching notes:', error);
    res.status(500).json({ error: 'Failed to fetch notes' });
  }
});

// Create note
app.post('/api/notes', async (req: Request, res: Response) => {
  try {
    const { title, content, markdown, tags } = req.body;
    const userId = req.user?.id;
    const noteId = uuidv4();

    const result = await pool.query(
      `INSERT INTO notes (id, user_id, title, content, markdown)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, title, created_at`,
      [noteId, userId, title || 'Untitled', content || '', markdown || '']
    );

    // Add tags if provided
    if (tags && Array.isArray(tags)) {
      for (const tagName of tags) {
        const tagResult = await pool.query(
          `INSERT INTO tags (user_id, name)
           VALUES ($1, $2)
           ON CONFLICT (user_id, name) DO UPDATE SET name = name
           RETURNING id`,
          [userId, tagName]
        );
        const tagId = tagResult.rows[0].id;
        await pool.query(
          `INSERT INTO note_tags (note_id, tag_id) VALUES ($1, $2)`,
          [noteId, tagId]
        );
      }
    }

    res.status(201).json({ data: result.rows[0] });
  } catch (error) {
    console.error('Error creating note:', error);
    res.status(500).json({ error: 'Failed to create note' });
  }
});

// Get note details
app.get('/api/notes/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;

    const noteResult = await pool.query(
      `SELECT id, title, content, markdown, created_at, updated_at FROM notes
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [id, userId]
    );

    if (noteResult.rows.length === 0) {
      return res.status(404).json({ error: 'Note not found' });
    }

    const note = noteResult.rows[0];

    // Get tags
    const tagsResult = await pool.query(
      `SELECT t.id, t.name, t.color FROM tags t
       INNER JOIN note_tags nt ON t.id = nt.tag_id
       WHERE nt.note_id = $1`,
      [id]
    );

    // Get links
    const linksResult = await pool.query(
      `SELECT target_note_id, title FROM note_links nl
       INNER JOIN notes n ON nl.target_note_id = n.id
       WHERE nl.source_note_id = $1`,
      [id]
    );

    res.json({
      data: {
        ...note,
        tags: tagsResult.rows,
        links: linksResult.rows
      }
    });
  } catch (error) {
    console.error('Error fetching note:', error);
    res.status(500).json({ error: 'Failed to fetch note' });
  }
});

// Update note
app.put('/api/notes/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { title, content, markdown, tags } = req.body;
    const userId = req.user?.id;

    // Update note
    const result = await pool.query(
      `UPDATE notes SET title = $1, content = $2, markdown = $3, updated_at = CURRENT_TIMESTAMP
       WHERE id = $4 AND user_id = $5
       RETURNING id, title, updated_at`,
      [title, content, markdown, id, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Note not found' });
    }

    // Update tags
    if (tags && Array.isArray(tags)) {
      await pool.query(`DELETE FROM note_tags WHERE note_id = $1`, [id]);

      for (const tagName of tags) {
        const tagResult = await pool.query(
          `INSERT INTO tags (user_id, name)
           VALUES ($1, $2)
           ON CONFLICT (user_id, name) DO UPDATE SET name = name
           RETURNING id`,
          [userId, tagName]
        );
        const tagId = tagResult.rows[0].id;
        await pool.query(
          `INSERT INTO note_tags (note_id, tag_id) VALUES ($1, $2)`,
          [id, tagId]
        );
      }
    }

    res.json({ data: result.rows[0] });
  } catch (error) {
    console.error('Error updating note:', error);
    res.status(500).json({ error: 'Failed to update note' });
  }
});

// Delete note
app.delete('/api/notes/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;

    const result = await pool.query(
      `UPDATE notes SET deleted_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND user_id = $2
       RETURNING id`,
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

// Get all tags
app.get('/api/tags', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const result = await pool.query(
      `SELECT id, name, color, COUNT(nt.note_id) as note_count
       FROM tags t
       LEFT JOIN note_tags nt ON t.id = nt.tag_id
       WHERE t.user_id = $1
       GROUP BY t.id, t.name, t.color
       ORDER BY name`,
      [userId]
    );
    res.json({ data: result.rows });
  } catch (error) {
    console.error('Error fetching tags:', error);
    res.status(500).json({ error: 'Failed to fetch tags' });
  }
});

// Search notes
app.get('/api/search', async (req: Request, res: Response) => {
  try {
    const { q } = req.query;
    const userId = req.user?.id;

    if (!q || typeof q !== 'string') {
      return res.json({ data: [] });
    }

    const searchQuery = `%${q}%`;
    const result = await pool.query(
      `SELECT id, title, description, created_at, updated_at
       FROM notes
       WHERE user_id = $1 AND deleted_at IS NULL
       AND (title ILIKE $2 OR content ILIKE $2 OR markdown ILIKE $2)
       ORDER BY updated_at DESC
       LIMIT 50`,
      [userId, searchQuery]
    );

    res.json({ data: result.rows });
  } catch (error) {
    console.error('Error searching notes:', error);
    res.status(500).json({ error: 'Failed to search notes' });
  }
});

// Get knowledge graph
app.get('/api/graph', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;

    const notesResult = await pool.query(
      `SELECT id, title FROM notes WHERE user_id = $1 AND deleted_at IS NULL LIMIT 500`,
      [userId]
    );

    const linksResult = await pool.query(
      `SELECT source_note_id, target_note_id FROM note_links
       WHERE source_note_id IN (
         SELECT id FROM notes WHERE user_id = $1 AND deleted_at IS NULL
       ) LIMIT 1000`,
      [userId]
    );

    res.json({
      data: {
        nodes: notesResult.rows.map(note => ({
          id: note.id,
          label: note.title
        })),
        edges: linksResult.rows.map(link => ({
          from: link.source_note_id,
          to: link.target_note_id
        }))
      }
    });
  } catch (error) {
    console.error('Error fetching graph:', error);
    res.status(500).json({ error: 'Failed to fetch graph' });
  }
});

// Error handling middleware
app.use((err: any, req: Request, res: Response, next: any) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
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
