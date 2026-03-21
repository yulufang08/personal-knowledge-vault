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
import multer from 'multer';

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
        link_type VARCHAR(20) DEFAULT 'wiki',
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

      CREATE TABLE IF NOT EXISTS cal_categories (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(100) NOT NULL,
        color VARCHAR(7) NOT NULL DEFAULT '#7c5cfc',
        icon VARCHAR(10) DEFAULT '',
        sort_order INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, name)
      );

      CREATE TABLE IF NOT EXISTS cal_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        category_id UUID REFERENCES cal_categories(id) ON DELETE SET NULL,
        title VARCHAR(255) NOT NULL,
        description TEXT DEFAULT '',
        start_time TIMESTAMPTZ NOT NULL,
        end_time TIMESTAMPTZ NOT NULL,
        all_day BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS cal_tasks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        category_id UUID REFERENCES cal_categories(id) ON DELETE SET NULL,
        title VARCHAR(255) NOT NULL,
        due_date DATE NOT NULL,
        due_time TIME,
        completed BOOLEAN DEFAULT false,
        completed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_cal_events_user_time ON cal_events(user_id, start_time, end_time);
      CREATE INDEX IF NOT EXISTS idx_cal_tasks_user_due ON cal_tasks(user_id, due_date);
      CREATE INDEX IF NOT EXISTS idx_cal_categories_user ON cal_categories(user_id);

      CREATE INDEX IF NOT EXISTS idx_ai_analyses_user ON ai_analyses(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sync_devices_user ON sync_devices(user_id);
      CREATE INDEX IF NOT EXISTS idx_ai_config_user ON user_ai_config(user_id);
      CREATE INDEX IF NOT EXISTS idx_agent_conv_user ON agent_conversations(user_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_msg_conv ON agent_messages(conversation_id, created_at);

      -- ===== COMMUNITY POSTS =====
      CREATE TABLE IF NOT EXISTS community_posts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        post_type VARCHAR(20) DEFAULT 'share',
        shared_note_id UUID REFERENCES notes(id) ON DELETE SET NULL,
        image_url TEXT,
        likes_count INT DEFAULT 0,
        comments_count INT DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS community_likes (
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        post_id UUID NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, post_id)
      );

      CREATE TABLE IF NOT EXISTS community_comments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        post_id UUID NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );

      -- ===== CHECK-IN STREAKS =====
      CREATE TABLE IF NOT EXISTS user_checkins (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        checkin_date DATE NOT NULL,
        post_id UUID REFERENCES community_posts(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, checkin_date)
      );

      -- ===== REFERRAL SYSTEM =====
      CREATE TABLE IF NOT EXISTS referral_rewards (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        referrer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        referred_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        reward_days INT DEFAULT 7,
        applied BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(referrer_id, referred_id)
      );

      -- ===== STUDENT VERIFICATION =====
      CREATE TABLE IF NOT EXISTS student_verifications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        student_email VARCHAR(255) NOT NULL,
        verification_code VARCHAR(6) NOT NULL,
        verified BOOLEAN DEFAULT false,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id)
      );

      -- ===== FEEDBACK =====
      CREATE TABLE IF NOT EXISTS user_feedback (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        category VARCHAR(50) DEFAULT 'feature',
        title VARCHAR(255) NOT NULL,
        content TEXT NOT NULL,
        status VARCHAR(20) DEFAULT 'pending',
        votes INT DEFAULT 0,
        admin_reply TEXT,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS feedback_votes (
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        feedback_id UUID NOT NULL REFERENCES user_feedback(id) ON DELETE CASCADE,
        PRIMARY KEY (user_id, feedback_id)
      );

      -- ===== FILES / DOCUMENTS =====
      CREATE TABLE IF NOT EXISTS user_files (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        filename VARCHAR(500) NOT NULL,
        original_name VARCHAR(500) NOT NULL,
        file_type VARCHAR(100) NOT NULL,
        file_size INT NOT NULL,
        file_data TEXT,
        annotations JSONB DEFAULT '[]'::jsonb,
        file_notes TEXT DEFAULT '',
        highlights JSONB DEFAULT '[]'::jsonb,
        page_count INT DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_user_files_user ON user_files(user_id, created_at DESC);

      -- ===== FRIENDS =====
      CREATE TABLE IF NOT EXISTS friendships (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        requester_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        addressee_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(requester_id, addressee_id)
      );

      -- ===== DIRECT MESSAGES =====
      CREATE TABLE IF NOT EXISTS conversations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_a UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        user_b UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        last_message_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_a, user_b)
      );

      CREATE TABLE IF NOT EXISTS direct_messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        content TEXT,
        message_type VARCHAR(20) DEFAULT 'text',
        shared_note_id UUID REFERENCES notes(id) ON DELETE SET NULL,
        is_read BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_community_posts_user ON community_posts(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_community_posts_created ON community_posts(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_community_comments_post ON community_comments(post_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_checkins_user ON user_checkins(user_id, checkin_date DESC);
      CREATE INDEX IF NOT EXISTS idx_feedback_votes ON user_feedback(votes DESC, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_friendships_users ON friendships(requester_id, addressee_id);
      CREATE INDEX IF NOT EXISTS idx_dm_conversation ON direct_messages(conversation_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_conversations_users ON conversations(user_a, user_b);
    `);

    // Add subscription column if it doesn't exist (migration for existing DBs)
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription VARCHAR(20) DEFAULT 'free';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMP;
      ALTER TABLE notes ADD COLUMN IF NOT EXISTS is_favorited BOOLEAN DEFAULT false;
      ALTER TABLE note_versions ADD COLUMN IF NOT EXISTS title VARCHAR(255);
      ALTER TABLE notes ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES notes(id) ON DELETE SET NULL;
      ALTER TABLE notes ADD COLUMN IF NOT EXISTS item_type VARCHAR(20) DEFAULT 'note';
      ALTER TABLE notes ADD COLUMN IF NOT EXISTS media_url TEXT;
      ALTER TABLE notes ADD COLUMN IF NOT EXISTS media_type VARCHAR(20);
      ALTER TABLE notes ADD COLUMN IF NOT EXISTS annotation TEXT;

      -- Personalization columns
      ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name VARCHAR(100);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_emoji VARCHAR(10) DEFAULT '👤';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_color VARCHAR(7) DEFAULT '#7c5cfc';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_agent_name VARCHAR(100) DEFAULT 'Fang''s AI';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_agent_emoji VARCHAR(10) DEFAULT '🧠';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_calls_me VARCHAR(100);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT DEFAULT '';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code VARCHAR(20);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by UUID;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS checkin_streak INT DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS longest_streak INT DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS total_checkins INT DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS student_verified BOOLEAN DEFAULT false;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS student_email VARCHAR(255);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS theme_color VARCHAR(20) DEFAULT 'purple';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS dark_mode BOOLEAN DEFAULT false;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS font_size VARCHAR(10) DEFAULT 'medium';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS editor_font_family VARCHAR(50) DEFAULT 'default';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS startup_page VARCHAR(20) DEFAULT 'home';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS sidebar_collapsed BOOLEAN DEFAULT false;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS show_word_count BOOLEAN DEFAULT true;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS show_line_numbers BOOLEAN DEFAULT false;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS spellcheck BOOLEAN DEFAULT true;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS date_format VARCHAR(20) DEFAULT 'YYYY-MM-DD';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS language VARCHAR(10) DEFAULT 'en';
    `);

    // Create default guest user
    await client.query(`
      INSERT INTO users (id, email, username, password_hash, subscription, referral_code)
      VALUES ('00000000-0000-0000-0000-000000000001', 'guest@example.com', 'guest', 'no-password', 'free', 'FANG-GUEST')
      ON CONFLICT (id) DO NOTHING
    `);
    // Ensure referral code exists for guest
    await client.query(`UPDATE users SET referral_code = 'FANG-GUEST' WHERE id = '00000000-0000-0000-0000-000000000001' AND referral_code IS NULL`);

    // Seed default calendar categories
    await client.query(`
      INSERT INTO cal_categories (user_id, name, color, icon, sort_order) VALUES
        ('00000000-0000-0000-0000-000000000001', 'Work', '#6366f1', '💼', 0),
        ('00000000-0000-0000-0000-000000000001', 'Study', '#f59e0b', '📚', 1),
        ('00000000-0000-0000-0000-000000000001', 'Exercise', '#10b981', '🏃', 2),
        ('00000000-0000-0000-0000-000000000001', 'Personal', '#ec4899', '🏠', 3),
        ('00000000-0000-0000-0000-000000000001', 'Meeting', '#8b5cf6', '🤝', 4),
        ('00000000-0000-0000-0000-000000000001', 'Health', '#ef4444', '❤️', 5)
      ON CONFLICT (user_id, name) DO NOTHING
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
      `SELECT id, email, username, subscription, subscription_expires_at, created_at,
       display_name, avatar_emoji, avatar_color, ai_agent_name, ai_agent_emoji, ai_calls_me,
       bio, referral_code, checkin_streak, longest_streak, total_checkins, student_verified, student_email,
       theme_color, dark_mode, font_size, editor_font_family, startup_page, sidebar_collapsed,
       show_word_count, show_line_numbers, spellcheck, date_format, language FROM users WHERE id = $1`,
      [userId]
    );
    const noteCount = await pool.query(
      `SELECT COUNT(*) as count FROM notes WHERE user_id = $1 AND deleted_at IS NULL`,
      [userId]
    );
    const user = userResult.rows[0] || {};
    const isPro = user.subscription === 'pro' &&
      (!user.subscription_expires_at || new Date(user.subscription_expires_at) > new Date());
    // Generate referral code if missing
    if (!user.referral_code) {
      const code = 'FANG-' + Math.random().toString(36).substring(2, 8).toUpperCase();
      await pool.query('UPDATE users SET referral_code = $1 WHERE id = $2', [code, userId]);
      user.referral_code = code;
    }
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

// Update user profile / personalization
app.put('/api/user/profile', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const { display_name, avatar_emoji, avatar_color, ai_agent_name, ai_agent_emoji, ai_calls_me, bio,
            theme_color, dark_mode, font_size, editor_font_family, startup_page, sidebar_collapsed,
            show_word_count, show_line_numbers, spellcheck, date_format, language } = req.body;
    const r = await pool.query(
      `UPDATE users SET
        display_name = COALESCE($2, display_name),
        avatar_emoji = COALESCE($3, avatar_emoji),
        avatar_color = COALESCE($4, avatar_color),
        ai_agent_name = COALESCE($5, ai_agent_name),
        ai_agent_emoji = COALESCE($6, ai_agent_emoji),
        ai_calls_me = COALESCE($7, ai_calls_me),
        bio = COALESCE($8, bio),
        theme_color = COALESCE($9, theme_color),
        dark_mode = COALESCE($10, dark_mode),
        font_size = COALESCE($11, font_size),
        editor_font_family = COALESCE($12, editor_font_family),
        startup_page = COALESCE($13, startup_page),
        sidebar_collapsed = COALESCE($14, sidebar_collapsed),
        show_word_count = COALESCE($15, show_word_count),
        show_line_numbers = COALESCE($16, show_line_numbers),
        spellcheck = COALESCE($17, spellcheck),
        date_format = COALESCE($18, date_format),
        language = COALESCE($19, language),
        updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING display_name, avatar_emoji, avatar_color, ai_agent_name, ai_agent_emoji, ai_calls_me, bio,
                 theme_color, dark_mode, font_size, editor_font_family, startup_page, sidebar_collapsed,
                 show_word_count, show_line_numbers, spellcheck, date_format, language`,
      [userId, display_name, avatar_emoji, avatar_color, ai_agent_name, ai_agent_emoji, ai_calls_me, bio,
       theme_color, dark_mode, font_size, editor_font_family, startup_page, sidebar_collapsed,
       show_word_count, show_line_numbers, spellcheck, date_format, language]
    );
    res.json({ data: r.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update profile' });
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
      `SELECT id, title, description, is_favorited, parent_id, item_type, media_url, media_type, annotation, created_at, updated_at FROM notes
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

// Helper: extract [[wiki links]] from markdown and save to note_links
async function extractAndSaveLinks(noteId: string, userId: string, markdown: string) {
  if (!markdown) return;
  const wikiLinkRegex = /\[\[([^\]]+)\]\]/g;
  const linkedTitles: string[] = [];
  let match;
  while ((match = wikiLinkRegex.exec(markdown)) !== null) {
    linkedTitles.push(match[1].trim());
  }
  // Delete old wiki links for this note
  await pool.query(`DELETE FROM note_links WHERE source_note_id = $1 AND link_type = 'wiki'`, [noteId]);
  if (linkedTitles.length === 0) return;
  // Find matching notes by title (case-insensitive, same user, not self)
  for (const title of linkedTitles) {
    const found = await pool.query(
      `SELECT id FROM notes WHERE user_id = $1 AND LOWER(title) = LOWER($2) AND id != $3 AND deleted_at IS NULL LIMIT 1`,
      [userId, title, noteId]
    );
    if (found.rows.length > 0) {
      await pool.query(
        `INSERT INTO note_links (source_note_id, target_note_id, link_type) VALUES ($1, $2, 'wiki')
         ON CONFLICT (source_note_id, target_note_id) DO UPDATE SET link_type = 'wiki'`,
        [noteId, found.rows[0].id]
      );
    }
  }
}

app.post('/api/notes', async (req: Request, res: Response) => {
  try {
    const { title, content, markdown, tags, parent_id, item_type, media_url, media_type, annotation } = req.body;
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
      `INSERT INTO notes (id, user_id, title, content, markdown, parent_id, item_type, media_url, media_type, annotation)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, title, item_type, parent_id, media_url, media_type, annotation, created_at`,
      [noteId, userId, title || 'Untitled', content || '', markdown || '', parent_id||null, item_type||'note', media_url||null, media_type||null, annotation||null]
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

    // Extract [[wiki links]] and save to note_links
    await extractAndSaveLinks(noteId, userId!, markdown || '');

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
      `SELECT id, title, content, markdown, is_favorited, parent_id, item_type, media_url, media_type, annotation, created_at, updated_at FROM notes
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
    const { title, content, markdown, tags, parent_id, item_type, media_url, media_type, annotation } = req.body;
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
      `UPDATE notes SET title = $1, content = $2, markdown = $3,
       parent_id = COALESCE($6, parent_id), item_type = COALESCE($7, item_type),
       media_url = COALESCE($8, media_url), media_type = COALESCE($9, media_type),
       annotation = COALESCE($10, annotation), updated_at = CURRENT_TIMESTAMP
       WHERE id = $4 AND user_id = $5 RETURNING id, title, item_type, parent_id, updated_at`,
      [title, content, markdown, id, userId, parent_id, item_type, media_url, media_type, annotation]
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

    // Extract [[wiki links]] and save to note_links
    await extractAndSaveLinks(id, userId!, markdown || '');

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
      `SELECT id, title, parent_id, item_type FROM notes WHERE user_id = $1 AND deleted_at IS NULL LIMIT 500`,
      [userId]
    );

    // 1. Wiki links (from note_links table)
    const wikiLinksResult = await pool.query(
      `SELECT source_note_id, target_note_id, 'wiki' as link_type FROM note_links
       WHERE source_note_id IN (SELECT id FROM notes WHERE user_id = $1 AND deleted_at IS NULL) LIMIT 1000`,
      [userId]
    );

    // 2. Shared-tag edges: notes that share at least one tag
    const tagLinksResult = await pool.query(
      `SELECT DISTINCT nt1.note_id as source_note_id, nt2.note_id as target_note_id, 'tag' as link_type
       FROM note_tags nt1
       JOIN note_tags nt2 ON nt1.tag_id = nt2.tag_id AND nt1.note_id < nt2.note_id
       WHERE nt1.note_id IN (SELECT id FROM notes WHERE user_id = $1 AND deleted_at IS NULL)
         AND nt2.note_id IN (SELECT id FROM notes WHERE user_id = $1 AND deleted_at IS NULL)
       LIMIT 1000`,
      [userId]
    );

    // 3. Parent-child edges
    const parentChildEdges = notesResult.rows
      .filter(n => n.parent_id)
      .map(n => ({ from: n.parent_id, to: n.id, type: 'parent' }));

    // Combine all edges, dedup by from+to
    const edgeMap = new Map<string, { from: string; to: string; type: string }>();
    for (const l of wikiLinksResult.rows) {
      const key = `${l.source_note_id}-${l.target_note_id}`;
      edgeMap.set(key, { from: l.source_note_id, to: l.target_note_id, type: 'wiki' });
    }
    for (const l of tagLinksResult.rows) {
      const key = `${l.source_note_id}-${l.target_note_id}`;
      if (!edgeMap.has(key)) edgeMap.set(key, { from: l.source_note_id, to: l.target_note_id, type: 'tag' });
    }
    for (const e of parentChildEdges) {
      const key = `${e.from}-${e.to}`;
      if (!edgeMap.has(key)) edgeMap.set(key, e);
    }

    res.json({
      data: {
        nodes: notesResult.rows.map(n => ({ id: n.id, label: n.title, type: n.item_type })),
        edges: Array.from(edgeMap.values())
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch graph' });
  }
});

// Rebuild all wiki links for existing notes (one-time migration helper)
app.post('/api/graph/rebuild', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const allNotes = await pool.query(
      `SELECT id, markdown FROM notes WHERE user_id = $1 AND deleted_at IS NULL`,
      [userId]
    );
    let linkCount = 0;
    for (const note of allNotes.rows) {
      await extractAndSaveLinks(note.id, userId!, note.markdown || '');
      const wikiLinkRegex = /\[\[([^\]]+)\]\]/g;
      let m; while ((m = wikiLinkRegex.exec(note.markdown || '')) !== null) linkCount++;
    }
    res.json({ message: `Rebuilt links for ${allNotes.rows.length} notes, found ${linkCount} wiki references` });
  } catch (error) {
    res.status(500).json({ error: 'Failed to rebuild graph links' });
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
      // Fetch user personalization for agent
      const profR = await pool.query('SELECT ai_agent_name, ai_calls_me, display_name FROM users WHERE id=$1', [userId]);
      const prof = profR.rows[0] || {};
      const agentName = prof.ai_agent_name || "Fang's AI";
      const callsMe = prof.ai_calls_me || prof.display_name || '';
      const systemPrompt = `You are "${agentName}", a helpful knowledge assistant for a personal knowledge base called "yulufang@sjtu.edu.cn" (by yulufang@sjtu.edu.cn).${callsMe ? ` Address the user as "${callsMe}".` : ''} The user has ${userNotes.length} notes.
${relevantNotes.length > 0 ? `\nRelevant notes found:\n${relevantNotes.map(n => `--- ${n.title} ---\n${n.content}`).join('\n\n')}` : ''}
\nHelp the user explore, understand, and build on their knowledge. Reference specific notes when relevant. Be concise and insightful. Support both Chinese and English. Stay in character as ${agentName}.`;

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

// ===== CALENDAR: CATEGORIES =====
app.get('/api/calendar/categories', authenticateToken, async (req: Request, res: Response) => {
  try {
    const r = await pool.query('SELECT * FROM cal_categories WHERE user_id=$1 ORDER BY sort_order', [req.user.id]);
    res.json({ data: r.rows });
  } catch(e) { res.status(500).json({ error: 'Failed to fetch categories' }); }
});

app.post('/api/calendar/categories', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { name, color, icon } = req.body;
    if (!name || !color) return res.status(400).json({ error: 'Name and color required' });
    const cnt = await pool.query('SELECT COUNT(*) FROM cal_categories WHERE user_id=$1', [req.user.id]);
    if (parseInt(cnt.rows[0].count) >= 20) return res.status(400).json({ error: 'Max 20 categories' });
    const r = await pool.query(
      'INSERT INTO cal_categories (user_id,name,color,icon,sort_order) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [req.user.id, name.trim(), color, icon || '', parseInt(cnt.rows[0].count)]
    );
    res.json({ data: r.rows[0] });
  } catch(e: any) {
    if (e.code === '23505') return res.status(400).json({ error: 'Category name already exists' });
    res.status(500).json({ error: 'Failed to create category' });
  }
});

app.put('/api/calendar/categories/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { name, color, icon, sort_order } = req.body;
    const r = await pool.query(
      `UPDATE cal_categories SET name=COALESCE($1,name), color=COALESCE($2,color),
       icon=COALESCE($3,icon), sort_order=COALESCE($4,sort_order)
       WHERE id=$5 AND user_id=$6 RETURNING *`,
      [name, color, icon, sort_order, req.params.id, req.user.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ data: r.rows[0] });
  } catch(e) { res.status(500).json({ error: 'Failed to update category' }); }
});

app.delete('/api/calendar/categories/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    await pool.query('DELETE FROM cal_categories WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    res.json({ data: { success: true } });
  } catch(e) { res.status(500).json({ error: 'Failed to delete category' }); }
});

// ===== CALENDAR: EVENTS =====
app.get('/api/calendar/events', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'start and end params required' });
    const r = await pool.query(
      `SELECT e.*, c.name as category_name, c.color as category_color, c.icon as category_icon
       FROM cal_events e LEFT JOIN cal_categories c ON e.category_id=c.id
       WHERE e.user_id=$1 AND e.start_time < $3::timestamptz AND e.end_time > $2::timestamptz
       ORDER BY e.start_time`,
      [req.user.id, start, end]
    );
    res.json({ data: r.rows });
  } catch(e) { res.status(500).json({ error: 'Failed to fetch events' }); }
});

app.post('/api/calendar/events', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { title, description, category_id, start_time, end_time, all_day } = req.body;
    if (!title || !start_time || !end_time) return res.status(400).json({ error: 'title, start_time, end_time required' });
    const r = await pool.query(
      `INSERT INTO cal_events (user_id,title,description,category_id,start_time,end_time,all_day)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.user.id, title.trim(), description||'', category_id||null, start_time, end_time, all_day||false]
    );
    // Join category info
    if (r.rows[0].category_id) {
      const c = await pool.query('SELECT name,color,icon FROM cal_categories WHERE id=$1', [r.rows[0].category_id]);
      if (c.rows[0]) { r.rows[0].category_name=c.rows[0].name; r.rows[0].category_color=c.rows[0].color; r.rows[0].category_icon=c.rows[0].icon; }
    }
    res.json({ data: r.rows[0] });
  } catch(e) { res.status(500).json({ error: 'Failed to create event' }); }
});

app.put('/api/calendar/events/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { title, description, category_id, start_time, end_time, all_day } = req.body;
    const r = await pool.query(
      `UPDATE cal_events SET title=COALESCE($1,title), description=COALESCE($2,description),
       category_id=$3, start_time=COALESCE($4,start_time), end_time=COALESCE($5,end_time),
       all_day=COALESCE($6,all_day), updated_at=CURRENT_TIMESTAMP
       WHERE id=$7 AND user_id=$8 RETURNING *`,
      [title, description, category_id||null, start_time, end_time, all_day, req.params.id, req.user.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ data: r.rows[0] });
  } catch(e) { res.status(500).json({ error: 'Failed to update event' }); }
});

app.delete('/api/calendar/events/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    await pool.query('DELETE FROM cal_events WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    res.json({ data: { success: true } });
  } catch(e) { res.status(500).json({ error: 'Failed to delete event' }); }
});

// ===== CALENDAR: TASKS =====
app.get('/api/calendar/tasks', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { start, end, completed } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'start and end params required' });
    let q = `SELECT t.*, c.name as category_name, c.color as category_color, c.icon as category_icon
             FROM cal_tasks t LEFT JOIN cal_categories c ON t.category_id=c.id
             WHERE t.user_id=$1 AND t.due_date >= $2::date AND t.due_date <= $3::date`;
    const params: any[] = [req.user.id, start, end];
    if (completed !== undefined) { q += ` AND t.completed=$${params.length+1}`; params.push(completed === 'true'); }
    q += ' ORDER BY t.due_date, t.due_time NULLS LAST';
    const r = await pool.query(q, params);
    res.json({ data: r.rows });
  } catch(e) { res.status(500).json({ error: 'Failed to fetch tasks' }); }
});

app.post('/api/calendar/tasks', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { title, category_id, due_date, due_time } = req.body;
    if (!title || !due_date) return res.status(400).json({ error: 'title and due_date required' });
    const r = await pool.query(
      `INSERT INTO cal_tasks (user_id,title,category_id,due_date,due_time) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.user.id, title.trim(), category_id||null, due_date, due_time||null]
    );
    if (r.rows[0].category_id) {
      const c = await pool.query('SELECT name,color,icon FROM cal_categories WHERE id=$1', [r.rows[0].category_id]);
      if (c.rows[0]) { r.rows[0].category_name=c.rows[0].name; r.rows[0].category_color=c.rows[0].color; r.rows[0].category_icon=c.rows[0].icon; }
    }
    res.json({ data: r.rows[0] });
  } catch(e) { res.status(500).json({ error: 'Failed to create task' }); }
});

app.put('/api/calendar/tasks/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { title, category_id, due_date, due_time, completed } = req.body;
    let completedAt = undefined;
    if (completed === true) completedAt = new Date().toISOString();
    if (completed === false) completedAt = null;
    const r = await pool.query(
      `UPDATE cal_tasks SET title=COALESCE($1,title), category_id=$2,
       due_date=COALESCE($3,due_date), due_time=$4,
       completed=COALESCE($5,completed), completed_at=COALESCE($6,completed_at),
       updated_at=CURRENT_TIMESTAMP
       WHERE id=$7 AND user_id=$8 RETURNING *`,
      [title, category_id!==undefined?category_id||null:undefined, due_date, due_time!==undefined?due_time||null:undefined, completed, completedAt, req.params.id, req.user.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ data: r.rows[0] });
  } catch(e) { res.status(500).json({ error: 'Failed to update task' }); }
});

app.patch('/api/calendar/tasks/:id/toggle', authenticateToken, async (req: Request, res: Response) => {
  try {
    const r = await pool.query(
      `UPDATE cal_tasks SET completed=NOT completed,
       completed_at=CASE WHEN completed THEN NULL ELSE CURRENT_TIMESTAMP END,
       updated_at=CURRENT_TIMESTAMP
       WHERE id=$1 AND user_id=$2 RETURNING *`,
      [req.params.id, req.user.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ data: r.rows[0] });
  } catch(e) { res.status(500).json({ error: 'Failed to toggle task' }); }
});

app.delete('/api/calendar/tasks/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    await pool.query('DELETE FROM cal_tasks WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    res.json({ data: { success: true } });
  } catch(e) { res.status(500).json({ error: 'Failed to delete task' }); }
});

// ===== CALENDAR: STATS =====
app.get('/api/calendar/stats', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'start and end params required' });
    // Time per category from events
    const timeR = await pool.query(`
      SELECT c.id as category_id, c.name, c.color, c.icon,
        COALESCE(SUM(EXTRACT(EPOCH FROM (
          LEAST(e.end_time, $3::timestamptz) - GREATEST(e.start_time, $2::timestamptz)
        )) / 3600.0), 0)::numeric(10,2) as total_hours,
        COUNT(e.id)::int as event_count
      FROM cal_categories c
      LEFT JOIN cal_events e ON e.category_id=c.id AND e.user_id=$1
        AND e.start_time < $3::timestamptz AND e.end_time > $2::timestamptz
      WHERE c.user_id=$1
      GROUP BY c.id, c.name, c.color, c.icon ORDER BY total_hours DESC
    `, [req.user.id, start, end]);

    // Task completion per category
    const taskR = await pool.query(`
      SELECT c.id as category_id, c.name, c.color,
        COUNT(*) FILTER (WHERE t.completed=true)::int as completed_count,
        COUNT(*)::int as total_count
      FROM cal_categories c
      LEFT JOIN cal_tasks t ON t.category_id=c.id AND t.user_id=$1
        AND t.due_date >= $2::date AND t.due_date <= $3::date
      WHERE c.user_id=$1
      GROUP BY c.id, c.name, c.color
    `, [req.user.id, start, end]);

    const totalHours = timeR.rows.reduce((s: number, r: any) => s + parseFloat(r.total_hours), 0);
    res.json({ data: { timeByCategory: timeR.rows, tasksByCategory: taskR.rows, totalHours: Math.round(totalHours * 10) / 10 } });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Failed to fetch stats' }); }
});

// ===== COMMUNITY =====
const CHECKIN_REWARD_MILESTONES: Record<number, number> = { 7: 3, 14: 5, 30: 7, 60: 14, 100: 30 }; // streak days -> pro days reward

// Get community feed
app.get('/api/community/feed', async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 0;
    const limit = 20;
    const r = await pool.query(
      `SELECT p.*, u.username, u.display_name, u.avatar_emoji, u.avatar_color,
       n.title as shared_note_title,
       EXISTS(SELECT 1 FROM community_likes cl WHERE cl.post_id=p.id AND cl.user_id=$1) as user_liked
       FROM community_posts p
       JOIN users u ON p.user_id=u.id
       LEFT JOIN notes n ON p.shared_note_id=n.id
       ORDER BY p.created_at DESC LIMIT $2 OFFSET $3`,
      [req.user.id, limit, page * limit]
    );
    res.json({ data: r.rows });
  } catch(e) { res.status(500).json({ error: 'Failed to fetch feed' }); }
});

// Create post
app.post('/api/community/posts', async (req: Request, res: Response) => {
  try {
    const { content, post_type, shared_note_id, image_url } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: 'Content required' });
    const r = await pool.query(
      `INSERT INTO community_posts (user_id, content, post_type, shared_note_id, image_url)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.user.id, content.trim(), post_type || 'share', shared_note_id || null, image_url || null]
    );
    res.json({ data: r.rows[0] });
  } catch(e) { res.status(500).json({ error: 'Failed to create post' }); }
});

// Delete own post
app.delete('/api/community/posts/:id', async (req: Request, res: Response) => {
  try {
    await pool.query('DELETE FROM community_posts WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    res.json({ data: { success: true } });
  } catch(e) { res.status(500).json({ error: 'Failed to delete post' }); }
});

// Like / unlike
app.post('/api/community/posts/:id/like', async (req: Request, res: Response) => {
  try {
    const exists = await pool.query('SELECT 1 FROM community_likes WHERE user_id=$1 AND post_id=$2', [req.user.id, req.params.id]);
    if (exists.rows.length) {
      await pool.query('DELETE FROM community_likes WHERE user_id=$1 AND post_id=$2', [req.user.id, req.params.id]);
      await pool.query('UPDATE community_posts SET likes_count=GREATEST(likes_count-1,0) WHERE id=$1', [req.params.id]);
      res.json({ data: { liked: false } });
    } else {
      await pool.query('INSERT INTO community_likes (user_id,post_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.user.id, req.params.id]);
      await pool.query('UPDATE community_posts SET likes_count=likes_count+1 WHERE id=$1', [req.params.id]);
      res.json({ data: { liked: true } });
    }
  } catch(e) { res.status(500).json({ error: 'Failed to toggle like' }); }
});

// Get comments
app.get('/api/community/posts/:id/comments', async (req: Request, res: Response) => {
  try {
    const r = await pool.query(
      `SELECT c.*, u.username, u.display_name, u.avatar_emoji, u.avatar_color
       FROM community_comments c JOIN users u ON c.user_id=u.id
       WHERE c.post_id=$1 ORDER BY c.created_at`,
      [req.params.id]
    );
    res.json({ data: r.rows });
  } catch(e) { res.status(500).json({ error: 'Failed to fetch comments' }); }
});

// Add comment
app.post('/api/community/posts/:id/comments', async (req: Request, res: Response) => {
  try {
    const { content } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: 'Content required' });
    const r = await pool.query(
      `INSERT INTO community_comments (post_id,user_id,content) VALUES ($1,$2,$3) RETURNING *`,
      [req.params.id, req.user.id, content.trim()]
    );
    await pool.query('UPDATE community_posts SET comments_count=comments_count+1 WHERE id=$1', [req.params.id]);
    res.json({ data: r.rows[0] });
  } catch(e) { res.status(500).json({ error: 'Failed to add comment' }); }
});

// ===== CHECK-IN =====
app.post('/api/checkin', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const today = new Date().toISOString().substring(0, 10);
    // Check if already checked in
    const existing = await pool.query('SELECT 1 FROM user_checkins WHERE user_id=$1 AND checkin_date=$2', [userId, today]);
    if (existing.rows.length) return res.json({ data: { already: true, message: 'Already checked in today' } });

    // Auto-create a check-in post
    const postR = await pool.query(
      `INSERT INTO community_posts (user_id, content, post_type) VALUES ($1, $2, 'checkin') RETURNING id`,
      [userId, req.body.message || `Checked in today! Keeping the streak going 🔥`]
    );
    await pool.query(
      'INSERT INTO user_checkins (user_id, checkin_date, post_id) VALUES ($1,$2,$3)',
      [userId, today, postR.rows[0].id]
    );

    // Calculate streak
    const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().substring(0, 10);
    const hadYesterday = await pool.query('SELECT 1 FROM user_checkins WHERE user_id=$1 AND checkin_date=$2', [userId, yesterdayStr]);
    const userR = await pool.query('SELECT checkin_streak, longest_streak, total_checkins FROM users WHERE id=$1', [userId]);
    const prev = userR.rows[0] || { checkin_streak: 0, longest_streak: 0, total_checkins: 0 };
    const newStreak = hadYesterday.rows.length ? prev.checkin_streak + 1 : 1;
    const newLongest = Math.max(newStreak, prev.longest_streak);
    const newTotal = prev.total_checkins + 1;

    await pool.query(
      'UPDATE users SET checkin_streak=$1, longest_streak=$2, total_checkins=$3 WHERE id=$4',
      [newStreak, newLongest, newTotal, userId]
    );

    // Check milestone rewards
    let rewardDays = 0;
    for (const [milestone, days] of Object.entries(CHECKIN_REWARD_MILESTONES)) {
      if (newStreak === parseInt(milestone)) { rewardDays = days; break; }
    }
    if (rewardDays > 0) {
      const user = await pool.query('SELECT subscription_expires_at FROM users WHERE id=$1', [userId]);
      const base = user.rows[0]?.subscription_expires_at && new Date(user.rows[0].subscription_expires_at) > new Date()
        ? new Date(user.rows[0].subscription_expires_at) : new Date();
      base.setDate(base.getDate() + rewardDays);
      await pool.query("UPDATE users SET subscription='pro', subscription_expires_at=$1 WHERE id=$2", [base.toISOString(), userId]);
    }

    res.json({ data: { streak: newStreak, longest: newLongest, total: newTotal, rewardDays, message: rewardDays ? `🎉 ${newStreak}-day streak! +${rewardDays} days Pro!` : `🔥 ${newStreak}-day streak!` } });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Failed to check in' }); }
});

// Get check-in status
app.get('/api/checkin/status', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const today = new Date().toISOString().substring(0, 10);
    const checked = await pool.query('SELECT 1 FROM user_checkins WHERE user_id=$1 AND checkin_date=$2', [userId, today]);
    const userR = await pool.query('SELECT checkin_streak, longest_streak, total_checkins FROM users WHERE id=$1', [userId]);
    const u = userR.rows[0] || {};
    // Get recent check-in dates for heatmap
    const recent = await pool.query(
      "SELECT checkin_date FROM user_checkins WHERE user_id=$1 AND checkin_date > CURRENT_DATE - INTERVAL '30 days' ORDER BY checkin_date",
      [userId]
    );
    res.json({ data: { checkedInToday: !!checked.rows.length, streak: u.checkin_streak||0, longest: u.longest_streak||0, total: u.total_checkins||0, recentDates: recent.rows.map((r: any) => r.checkin_date), milestones: CHECKIN_REWARD_MILESTONES } });
  } catch(e) { res.status(500).json({ error: 'Failed to fetch check-in status' }); }
});

// ===== REFERRAL SYSTEM =====
app.post('/api/referral/apply', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Referral code required' });
    // Find referrer
    const referrer = await pool.query('SELECT id FROM users WHERE referral_code=$1 AND id!=$2', [code.toUpperCase(), userId]);
    if (!referrer.rows.length) return res.status(404).json({ error: 'Invalid referral code' });
    const referrerId = referrer.rows[0].id;
    // Check not already referred
    const existing = await pool.query('SELECT 1 FROM referral_rewards WHERE referred_id=$1', [userId]);
    if (existing.rows.length) return res.status(400).json({ error: 'You have already used a referral code' });
    // Create reward for both parties
    const rewardDays = 7;
    await pool.query(
      'INSERT INTO referral_rewards (referrer_id, referred_id, reward_days, applied) VALUES ($1,$2,$3,true)',
      [referrerId, userId, rewardDays]
    );
    await pool.query('UPDATE users SET referred_by=$1 WHERE id=$2', [referrerId, userId]);
    // Add pro days to both users
    for (const uid of [referrerId, userId]) {
      const u = await pool.query('SELECT subscription_expires_at FROM users WHERE id=$1', [uid]);
      const base = u.rows[0]?.subscription_expires_at && new Date(u.rows[0].subscription_expires_at) > new Date()
        ? new Date(u.rows[0].subscription_expires_at) : new Date();
      base.setDate(base.getDate() + rewardDays);
      await pool.query("UPDATE users SET subscription='pro', subscription_expires_at=$1 WHERE id=$2", [base.toISOString(), uid]);
    }
    res.json({ data: { message: `Both you and your friend received ${rewardDays} days of Pro!`, rewardDays } });
  } catch(e) { res.status(500).json({ error: 'Failed to apply referral' }); }
});

// Get referral info
app.get('/api/referral/info', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const u = await pool.query('SELECT referral_code FROM users WHERE id=$1', [userId]);
    const refs = await pool.query(
      `SELECT rr.created_at, rr.reward_days, u.username, u.display_name, u.avatar_emoji
       FROM referral_rewards rr JOIN users u ON rr.referred_id=u.id WHERE rr.referrer_id=$1 ORDER BY rr.created_at DESC`,
      [userId]
    );
    const totalEarned = refs.rows.reduce((s: number, r: any) => s + r.reward_days, 0);
    res.json({ data: { code: u.rows[0]?.referral_code, referrals: refs.rows, totalEarnedDays: totalEarned } });
  } catch(e) { res.status(500).json({ error: 'Failed to fetch referral info' }); }
});

// ===== SHARE =====
app.get('/api/notes/:id/share', async (req: Request, res: Response) => {
  try {
    const r = await pool.query(
      `SELECT n.title, n.content, n.markdown, u.username, u.display_name, u.avatar_emoji
       FROM notes n JOIN users u ON n.user_id=u.id WHERE n.id=$1 AND n.user_id=$2 AND n.deleted_at IS NULL`,
      [req.params.id, req.user.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Note not found' });
    const note = r.rows[0];
    const shareText = `${note.title}\n\n${(note.markdown || note.content || '').substring(0, 280)}`;
    res.json({ data: { title: note.title, text: shareText, author: note.display_name || note.username, authorEmoji: note.avatar_emoji } });
  } catch(e) { res.status(500).json({ error: 'Failed to get share data' }); }
});

// ===== STUDENT EMAIL VERIFICATION =====
const EDU_DOMAINS = ['edu.cn', 'edu', 'ac.uk', 'edu.au', 'edu.sg', 'edu.hk', 'edu.tw', 'ac.jp', 'ac.kr'];

function isEduEmail(email: string): boolean {
  const domain = email.split('@')[1]?.toLowerCase() || '';
  return EDU_DOMAINS.some(edu => domain.endsWith(edu));
}

// Request student verification (sends a code)
app.post('/api/student/verify-request', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const { student_email } = req.body;
    if (!student_email) return res.status(400).json({ error: 'Student email required' });
    if (!isEduEmail(student_email)) return res.status(400).json({ error: 'Please use a valid student email (.edu.cn, .edu, .ac.uk, etc.)' });

    // Check if already verified
    const existing = await pool.query('SELECT student_verified FROM users WHERE id=$1', [userId]);
    if (existing.rows[0]?.student_verified) return res.status(400).json({ error: 'Already verified as a student' });

    // Generate 6-digit code
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 min

    await pool.query(
      `INSERT INTO student_verifications (user_id, student_email, verification_code, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET student_email=$2, verification_code=$3, verified=false, expires_at=$4`,
      [userId, student_email, code, expiresAt.toISOString()]
    );

    // In production, send email. For demo, return the code in response.
    console.log(`[Student Verify] Code for ${student_email}: ${code}`);
    res.json({ data: { message: 'Verification code sent to your student email!', hint: `Demo mode: your code is ${code}`, expiresIn: '30 minutes' } });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Failed to send verification' }); }
});

// Confirm verification code
app.post('/api/student/verify-confirm', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Verification code required' });

    const vr = await pool.query(
      'SELECT * FROM student_verifications WHERE user_id=$1 AND verification_code=$2 AND verified=false AND expires_at > NOW()',
      [userId, code]
    );
    if (!vr.rows.length) return res.status(400).json({ error: 'Invalid or expired verification code' });

    // Mark as verified
    await pool.query('UPDATE student_verifications SET verified=true WHERE user_id=$1', [userId]);
    await pool.query('UPDATE users SET student_verified=true, student_email=$1 WHERE id=$2', [vr.rows[0].student_email, userId]);

    // Grant 1 year of Pro
    const expiresAt = new Date();
    expiresAt.setFullYear(expiresAt.getFullYear() + 1);
    await pool.query(
      "UPDATE users SET subscription='pro', subscription_expires_at=$1 WHERE id=$2",
      [expiresAt.toISOString(), userId]
    );

    res.json({ data: { message: 'Student verified! You now have 1 year of Pro for free!', proExpires: expiresAt.toISOString() } });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Verification failed' }); }
});

// Get student verification status
app.get('/api/student/status', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const u = await pool.query('SELECT student_verified, student_email FROM users WHERE id=$1', [userId]);
    res.json({ data: { verified: u.rows[0]?.student_verified || false, email: u.rows[0]?.student_email || null } });
  } catch(e) { res.status(500).json({ error: 'Failed to check status' }); }
});

// ===== FEEDBACK SYSTEM =====
app.get('/api/feedback', async (req: Request, res: Response) => {
  try {
    const category = req.query.category as string;
    const sort = req.query.sort === 'votes' ? 'f.votes DESC' : 'f.created_at DESC';
    let q = `SELECT f.*, u.username, u.display_name, u.avatar_emoji, u.avatar_color,
      EXISTS(SELECT 1 FROM feedback_votes fv WHERE fv.feedback_id=f.id AND fv.user_id=$1) as user_voted
      FROM user_feedback f JOIN users u ON f.user_id=u.id`;
    const params: any[] = [req.user.id];
    if (category && category !== 'all') { q += ` WHERE f.category=$2`; params.push(category); }
    q += ` ORDER BY ${sort} LIMIT 50`;
    const r = await pool.query(q, params);
    res.json({ data: r.rows });
  } catch(e) { res.status(500).json({ error: 'Failed to fetch feedback' }); }
});

app.post('/api/feedback', async (req: Request, res: Response) => {
  try {
    const { title, content, category } = req.body;
    if (!title?.trim() || !content?.trim()) return res.status(400).json({ error: 'Title and content required' });
    const r = await pool.query(
      'INSERT INTO user_feedback (user_id, title, content, category) VALUES ($1,$2,$3,$4) RETURNING *',
      [req.user.id, title.trim(), content.trim(), category || 'feature']
    );
    res.json({ data: r.rows[0] });
  } catch(e) { res.status(500).json({ error: 'Failed to submit feedback' }); }
});

app.post('/api/feedback/:id/vote', async (req: Request, res: Response) => {
  try {
    const exists = await pool.query('SELECT 1 FROM feedback_votes WHERE user_id=$1 AND feedback_id=$2', [req.user.id, req.params.id]);
    if (exists.rows.length) {
      await pool.query('DELETE FROM feedback_votes WHERE user_id=$1 AND feedback_id=$2', [req.user.id, req.params.id]);
      await pool.query('UPDATE user_feedback SET votes=GREATEST(votes-1,0) WHERE id=$1', [req.params.id]);
      res.json({ data: { voted: false } });
    } else {
      await pool.query('INSERT INTO feedback_votes (user_id,feedback_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.user.id, req.params.id]);
      await pool.query('UPDATE user_feedback SET votes=votes+1 WHERE id=$1', [req.params.id]);
      res.json({ data: { voted: true } });
    }
  } catch(e) { res.status(500).json({ error: 'Failed to vote' }); }
});

app.delete('/api/feedback/:id', async (req: Request, res: Response) => {
  try {
    await pool.query('DELETE FROM user_feedback WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    res.json({ data: { success: true } });
  } catch(e) { res.status(500).json({ error: 'Failed to delete' }); }
});

// ===== FRIENDS SYSTEM =====
// Search users to add as friend
app.get('/api/friends/search', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const q = (req.query.q as string || '').trim();
    if (q.length < 2) return res.json({ data: [] });
    const r = await pool.query(
      `SELECT id, username, display_name, avatar_emoji, avatar_color, bio FROM users
       WHERE id != $1 AND (LOWER(username) LIKE $2 OR LOWER(display_name) LIKE $2 OR LOWER(email) LIKE $2)
       LIMIT 20`,
      [userId, `%${q.toLowerCase()}%`]
    );
    res.json({ data: r.rows });
  } catch(e) { res.status(500).json({ error: 'Search failed' }); }
});

// Send friend request
app.post('/api/friends/request', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const { addressee_id } = req.body;
    if (userId === addressee_id) return res.status(400).json({ error: 'Cannot add yourself' });
    // Check existing
    const existing = await pool.query(
      `SELECT * FROM friendships WHERE
        (requester_id=$1 AND addressee_id=$2) OR (requester_id=$2 AND addressee_id=$1)`,
      [userId, addressee_id]
    );
    if (existing.rows.length) {
      const f = existing.rows[0];
      if (f.status === 'accepted') return res.status(400).json({ error: 'Already friends' });
      if (f.status === 'pending') return res.status(400).json({ error: 'Request already pending' });
    }
    await pool.query(
      `INSERT INTO friendships (requester_id, addressee_id, status) VALUES ($1, $2, 'pending')
       ON CONFLICT (requester_id, addressee_id) DO UPDATE SET status='pending', updated_at=CURRENT_TIMESTAMP`,
      [userId, addressee_id]
    );
    res.json({ data: { success: true } });
  } catch(e) { res.status(500).json({ error: 'Failed to send request' }); }
});

// Accept/reject friend request
app.put('/api/friends/respond', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const { friendship_id, action } = req.body; // action: 'accept' | 'reject'
    if (action === 'accept') {
      await pool.query(
        `UPDATE friendships SET status='accepted', updated_at=CURRENT_TIMESTAMP
         WHERE id=$1 AND addressee_id=$2 AND status='pending'`,
        [friendship_id, userId]
      );
    } else {
      await pool.query(
        `DELETE FROM friendships WHERE id=$1 AND addressee_id=$2 AND status='pending'`,
        [friendship_id, userId]
      );
    }
    res.json({ data: { success: true } });
  } catch(e) { res.status(500).json({ error: 'Failed to respond' }); }
});

// Get friends list + pending requests
app.get('/api/friends', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    // Accepted friends
    const friends = await pool.query(
      `SELECT f.id as friendship_id, f.created_at,
        CASE WHEN f.requester_id=$1 THEN u2.id ELSE u1.id END as friend_id,
        CASE WHEN f.requester_id=$1 THEN u2.username ELSE u1.username END as username,
        CASE WHEN f.requester_id=$1 THEN u2.display_name ELSE u1.display_name END as display_name,
        CASE WHEN f.requester_id=$1 THEN u2.avatar_emoji ELSE u1.avatar_emoji END as avatar_emoji,
        CASE WHEN f.requester_id=$1 THEN u2.avatar_color ELSE u1.avatar_color END as avatar_color,
        CASE WHEN f.requester_id=$1 THEN u2.bio ELSE u1.bio END as bio
       FROM friendships f
       JOIN users u1 ON f.requester_id=u1.id
       JOIN users u2 ON f.addressee_id=u2.id
       WHERE (f.requester_id=$1 OR f.addressee_id=$1) AND f.status='accepted'
       ORDER BY f.updated_at DESC`,
      [userId]
    );
    // Pending incoming
    const pending = await pool.query(
      `SELECT f.id as friendship_id, f.created_at, u.id as friend_id,
        u.username, u.display_name, u.avatar_emoji, u.avatar_color, u.bio
       FROM friendships f JOIN users u ON f.requester_id=u.id
       WHERE f.addressee_id=$1 AND f.status='pending'
       ORDER BY f.created_at DESC`,
      [userId]
    );
    res.json({ data: { friends: friends.rows, pending: pending.rows } });
  } catch(e) { res.status(500).json({ error: 'Failed to get friends' }); }
});

// Remove friend
app.delete('/api/friends/:friendshipId', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    await pool.query(
      `DELETE FROM friendships WHERE id=$1 AND (requester_id=$2 OR addressee_id=$2)`,
      [req.params.friendshipId, userId]
    );
    res.json({ data: { success: true } });
  } catch(e) { res.status(500).json({ error: 'Failed to remove friend' }); }
});

// ===== DIRECT MESSAGING =====
// Get or create conversation
app.post('/api/messages/conversation', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const { friend_id } = req.body;
    const [a, b] = [userId, friend_id].sort();
    // Check friendship
    const friendship = await pool.query(
      `SELECT 1 FROM friendships WHERE
        ((requester_id=$1 AND addressee_id=$2) OR (requester_id=$2 AND addressee_id=$1))
        AND status='accepted'`,
      [userId, friend_id]
    );
    if (!friendship.rows.length) return res.status(403).json({ error: 'Not friends' });
    // Get or create
    let conv = await pool.query(
      `SELECT id FROM conversations WHERE user_a=$1 AND user_b=$2`, [a, b]
    );
    if (!conv.rows.length) {
      conv = await pool.query(
        `INSERT INTO conversations (user_a, user_b) VALUES ($1, $2) RETURNING id`, [a, b]
      );
    }
    res.json({ data: { conversation_id: conv.rows[0].id } });
  } catch(e) { res.status(500).json({ error: 'Failed to get conversation' }); }
});

// Get conversations list
app.get('/api/messages/conversations', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const r = await pool.query(
      `SELECT c.id, c.last_message_at,
        CASE WHEN c.user_a=$1 THEN u2.id ELSE u1.id END as friend_id,
        CASE WHEN c.user_a=$1 THEN u2.username ELSE u1.username END as username,
        CASE WHEN c.user_a=$1 THEN u2.display_name ELSE u1.display_name END as display_name,
        CASE WHEN c.user_a=$1 THEN u2.avatar_emoji ELSE u1.avatar_emoji END as avatar_emoji,
        CASE WHEN c.user_a=$1 THEN u2.avatar_color ELSE u1.avatar_color END as avatar_color,
        (SELECT content FROM direct_messages dm WHERE dm.conversation_id=c.id ORDER BY dm.created_at DESC LIMIT 1) as last_message,
        (SELECT message_type FROM direct_messages dm WHERE dm.conversation_id=c.id ORDER BY dm.created_at DESC LIMIT 1) as last_message_type,
        (SELECT COUNT(*) FROM direct_messages dm WHERE dm.conversation_id=c.id AND dm.sender_id!=$1 AND dm.is_read=false)::int as unread_count
       FROM conversations c
       JOIN users u1 ON c.user_a=u1.id
       JOIN users u2 ON c.user_b=u2.id
       WHERE c.user_a=$1 OR c.user_b=$1
       ORDER BY c.last_message_at DESC`,
      [userId]
    );
    res.json({ data: r.rows });
  } catch(e) { res.status(500).json({ error: 'Failed to get conversations' }); }
});

// Get messages in a conversation
app.get('/api/messages/:conversationId', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const convId = req.params.conversationId;
    // Verify user is part of conversation
    const conv = await pool.query(
      `SELECT 1 FROM conversations WHERE id=$1 AND (user_a=$2 OR user_b=$2)`, [convId, userId]
    );
    if (!conv.rows.length) return res.status(403).json({ error: 'Access denied' });
    // Mark as read
    await pool.query(
      `UPDATE direct_messages SET is_read=true WHERE conversation_id=$1 AND sender_id!=$2 AND is_read=false`,
      [convId, userId]
    );
    // Get messages
    const r = await pool.query(
      `SELECT dm.*, u.username, u.display_name, u.avatar_emoji, u.avatar_color,
        n.title as shared_note_title, n.markdown as shared_note_preview
       FROM direct_messages dm
       JOIN users u ON dm.sender_id=u.id
       LEFT JOIN notes n ON dm.shared_note_id=n.id
       WHERE dm.conversation_id=$1
       ORDER BY dm.created_at ASC
       LIMIT 200`,
      [convId]
    );
    res.json({ data: r.rows });
  } catch(e) { res.status(500).json({ error: 'Failed to get messages' }); }
});

// Send message
app.post('/api/messages/:conversationId', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const convId = req.params.conversationId;
    const { content, message_type, shared_note_id } = req.body;
    // Verify access
    const conv = await pool.query(
      `SELECT 1 FROM conversations WHERE id=$1 AND (user_a=$2 OR user_b=$2)`, [convId, userId]
    );
    if (!conv.rows.length) return res.status(403).json({ error: 'Access denied' });
    const r = await pool.query(
      `INSERT INTO direct_messages (conversation_id, sender_id, content, message_type, shared_note_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [convId, userId, content || '', message_type || 'text', shared_note_id || null]
    );
    // Update conversation timestamp
    await pool.query(`UPDATE conversations SET last_message_at=CURRENT_TIMESTAMP WHERE id=$1`, [convId]);
    res.json({ data: r.rows[0] });
  } catch(e) { res.status(500).json({ error: 'Failed to send message' }); }
});

// Get total unread count
app.get('/api/messages/unread/count', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const r = await pool.query(
      `SELECT COUNT(*)::int as count FROM direct_messages dm
       JOIN conversations c ON dm.conversation_id=c.id
       WHERE (c.user_a=$1 OR c.user_b=$1) AND dm.sender_id!=$1 AND dm.is_read=false`,
      [userId]
    );
    res.json({ data: { count: r.rows[0].count } });
  } catch(e) { res.status(500).json({ error: 'Failed' }); }
});

// ===== FILE UPLOAD & DOCUMENT MANAGEMENT =====
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } }); // 15MB limit

// Upload file
app.post('/api/files', upload.single('file'), async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const file = (req as any).file;
    if (!file) return res.status(400).json({ error: 'No file provided' });
    const base64 = file.buffer.toString('base64');
    const r = await pool.query(
      `INSERT INTO user_files (user_id, filename, original_name, file_type, file_size, file_data)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, filename, original_name, file_type, file_size, page_count, created_at`,
      [userId, file.originalname, file.originalname, file.mimetype, file.size, base64]
    );
    res.json({ data: r.rows[0] });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Upload failed' }); }
});

// List files
app.get('/api/files', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const search = (req.query.q as string || '').trim();
    let q = `SELECT id, filename, original_name, file_type, file_size, page_count, annotations, file_notes, highlights, created_at, updated_at FROM user_files WHERE user_id=$1`;
    const params: any[] = [userId];
    if (search) { q += ` AND LOWER(original_name) LIKE $2`; params.push(`%${search.toLowerCase()}%`); }
    q += ` ORDER BY created_at DESC`;
    const r = await pool.query(q, params);
    res.json({ data: r.rows });
  } catch(e) { res.status(500).json({ error: 'Failed to list files' }); }
});

// Get file content (base64)
app.get('/api/files/:id/content', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const r = await pool.query(
      `SELECT file_data, file_type, original_name FROM user_files WHERE id=$1 AND user_id=$2`,
      [req.params.id, userId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'File not found' });
    const file = r.rows[0];
    const buffer = Buffer.from(file.file_data, 'base64');
    res.setHeader('Content-Type', file.file_type);
    res.setHeader('Content-Disposition', `inline; filename="${file.original_name}"`);
    res.send(buffer);
  } catch(e) { res.status(500).json({ error: 'Failed to get file' }); }
});

// Update annotations/highlights/notes for a file
app.put('/api/files/:id', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const { annotations, highlights, file_notes, page_count } = req.body;
    const sets: string[] = ['updated_at=CURRENT_TIMESTAMP'];
    const params: any[] = [req.params.id, userId];
    let idx = 3;
    if (annotations !== undefined) { sets.push(`annotations=$${idx}::jsonb`); params.push(JSON.stringify(annotations)); idx++; }
    if (highlights !== undefined) { sets.push(`highlights=$${idx}::jsonb`); params.push(JSON.stringify(highlights)); idx++; }
    if (file_notes !== undefined) { sets.push(`file_notes=$${idx}`); params.push(file_notes); idx++; }
    if (page_count !== undefined) { sets.push(`page_count=$${idx}`); params.push(page_count); idx++; }
    const r = await pool.query(
      `UPDATE user_files SET ${sets.join(',')} WHERE id=$1 AND user_id=$2
       RETURNING id, annotations, highlights, file_notes, page_count, updated_at`,
      params
    );
    res.json({ data: r.rows[0] });
  } catch(e) { res.status(500).json({ error: 'Failed to update' }); }
});

// Delete file
app.delete('/api/files/:id', async (req: Request, res: Response) => {
  try {
    await pool.query('DELETE FROM user_files WHERE id=$1 AND user_id=$2', [req.params.id, req.user?.id]);
    res.json({ data: { success: true } });
  } catch(e) { res.status(500).json({ error: 'Failed to delete' }); }
});

// AI Q&A about a document
app.post('/api/files/:id/ask', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const { question } = req.body;
    // Get file info and notes
    const fileR = await pool.query(
      `SELECT original_name, file_type, file_notes, annotations, highlights FROM user_files WHERE id=$1 AND user_id=$2`,
      [req.params.id, userId]
    );
    if (!fileR.rows.length) return res.status(404).json({ error: 'File not found' });
    const file = fileR.rows[0];
    // Get AI config
    const configResult = await pool.query(`SELECT ai_provider, ai_api_key, ai_model, ai_base_url FROM users WHERE id = $1`, [userId]);
    const config = configResult.rows[0];
    if (!config?.ai_api_key) return res.status(400).json({ error: 'Please configure your AI provider first' });

    const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'default-dev-key-change-in-prod!!';
    let apiKey = config.ai_api_key;
    try {
      const [ivHex, encrypted] = apiKey.split(':');
      const decipher = crypto.createDecipheriv('aes-256-gcm', crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32),
        Buffer.from(ivHex.substring(0, 24), 'hex'));
      decipher.setAuthTag(Buffer.from(ivHex.substring(24), 'hex'));
      apiKey = decipher.update(encrypted, 'hex', 'utf8') + decipher.final('utf8');
    } catch(e) {}

    const annotations = file.annotations || [];
    const highlights = file.highlights || [];
    const docContext = `Document: "${file.original_name}" (${file.file_type})
User's notes on this document: ${file.file_notes || 'None'}
Highlights (${highlights.length}): ${highlights.map((h: any) => `[Page ${h.page}] "${h.text}"`).join('; ') || 'None'}
Annotations (${annotations.length}): ${annotations.map((a: any) => `[Page ${a.page}] ${a.text}`).join('; ') || 'None'}`;

    const systemPrompt = `You are a document assistant. The user is reading a document and asking questions about it. Use the document context provided to answer. If the information isn't in the context, say so clearly. Be concise and helpful.\n\n${docContext}`;

    const provider = config.ai_provider || 'openai';
    const baseUrl = config.ai_base_url || (provider === 'anthropic' ? 'https://api.anthropic.com' : provider === 'deepseek' ? 'https://api.deepseek.com' : 'https://api.openai.com');
    const model = config.ai_model || (provider === 'anthropic' ? 'claude-sonnet-4-20250514' : provider === 'deepseek' ? 'deepseek-chat' : 'gpt-4o-mini');

    if (provider === 'anthropic') {
      const resp = await axios.post(`${baseUrl}/v1/messages`, {
        model, max_tokens: 1024, system: systemPrompt,
        messages: [{ role: 'user', content: question }]
      }, { headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' } });
      res.json({ data: { answer: resp.data.content[0].text } });
    } else {
      const resp = await axios.post(`${baseUrl}/v1/chat/completions`, {
        model, max_tokens: 1024,
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: question }]
      }, { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' } });
      res.json({ data: { answer: resp.data.choices[0].message.content } });
    }
  } catch(e: any) { res.status(500).json({ error: e.response?.data?.error?.message || 'AI query failed' }); }
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
