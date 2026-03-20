import express, { Express, Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
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

app.use(authenticateToken);

// Routes

// Frontend - serve a complete single-page application
app.get('/', (req: Request, res: Response) => {
  res.send(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Knowledge Vault - Personal Knowledge Base</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--primary:#6366f1;--primary-dark:#4f46e5;--bg:#0f172a;--bg2:#1e293b;--bg3:#334155;--text:#f1f5f9;--text2:#94a3b8;--border:#475569;--success:#10b981;--error:#ef4444;--warning:#f59e0b}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--text);height:100vh;overflow:hidden}
.app{display:flex;height:100vh}
.sidebar{width:280px;background:var(--bg2);border-right:1px solid var(--border);display:flex;flex-direction:column;flex-shrink:0}
.sidebar-header{padding:20px;border-bottom:1px solid var(--border)}
.sidebar-header h1{font-size:1.3rem;display:flex;align-items:center;gap:10px}
.sidebar-header h1 span{font-size:1.5rem}
.new-btn{width:100%;margin:16px 0;padding:12px;background:var(--primary);color:#fff;border:none;border-radius:8px;font-size:0.95rem;cursor:pointer;font-weight:600;transition:all .2s}
.new-btn:hover{background:var(--primary-dark);transform:translateY(-1px)}
.search-box{margin:0 16px 16px;position:relative}
.search-box input{width:100%;padding:10px 12px 10px 36px;background:var(--bg3);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:0.9rem;outline:none}
.search-box input:focus{border-color:var(--primary)}
.search-box::before{content:"\\1F50D";position:absolute;left:10px;top:50%;transform:translateY(-50%);font-size:0.85rem}
.nav{flex:1;overflow-y:auto;padding:8px}
.nav-item{padding:10px 16px;border-radius:8px;cursor:pointer;display:flex;align-items:center;gap:10px;color:var(--text2);transition:all .15s;font-size:0.9rem}
.nav-item:hover{background:var(--bg3);color:var(--text)}
.nav-item.active{background:var(--primary);color:#fff}
.notes-list{padding:8px;max-height:calc(100vh - 320px);overflow-y:auto}
.note-item{padding:12px;border-radius:8px;cursor:pointer;margin-bottom:4px;transition:all .15s}
.note-item:hover{background:var(--bg3)}
.note-item.active{background:var(--bg3);border-left:3px solid var(--primary)}
.note-item h4{font-size:0.9rem;margin-bottom:4px;color:var(--text)}
.note-item p{font-size:0.8rem;color:var(--text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.note-item time{font-size:0.75rem;color:var(--text2)}
.main{flex:1;display:flex;flex-direction:column;overflow:hidden}
.toolbar{padding:12px 24px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px;background:var(--bg2)}
.toolbar input{flex:1;padding:8px 12px;background:transparent;border:none;color:var(--text);font-size:1.4rem;font-weight:600;outline:none}
.toolbar input::placeholder{color:var(--text2)}
.toolbar button{padding:8px 16px;border:none;border-radius:6px;cursor:pointer;font-weight:500;font-size:0.85rem;transition:all .2s}
.save-btn{background:var(--success);color:#fff}
.save-btn:hover{opacity:.9}
.del-btn{background:var(--error);color:#fff;padding:8px 12px}
.del-btn:hover{opacity:.9}
.tags-bar{padding:8px 24px;border-bottom:1px solid var(--border);display:flex;flex-wrap:wrap;gap:6px;align-items:center;background:var(--bg2)}
.tag{background:rgba(99,102,241,.2);color:var(--primary);padding:4px 12px;border-radius:20px;font-size:0.8rem;display:flex;align-items:center;gap:4px}
.tag button{background:none;border:none;color:var(--primary);cursor:pointer;font-size:1rem}
.tags-bar input{background:transparent;border:1px solid var(--border);padding:4px 8px;border-radius:6px;color:var(--text);font-size:0.8rem;outline:none;width:160px}
.editor-area{flex:1;display:flex;overflow:hidden}
.editor{flex:1;padding:24px;overflow-y:auto}
.editor textarea{width:100%;height:100%;background:transparent;border:none;color:var(--text);font-family:'Monaco','Menlo','Ubuntu Mono',monospace;font-size:0.95rem;line-height:1.7;resize:none;outline:none}
.preview{flex:1;padding:24px;overflow-y:auto;border-left:1px solid var(--border)}
.preview h1{font-size:1.8rem;margin:16px 0 8px}
.preview h2{font-size:1.4rem;margin:14px 0 6px;color:var(--primary)}
.preview h3{font-size:1.1rem;margin:12px 0 4px}
.preview p{margin:8px 0;line-height:1.7;color:var(--text2)}
.preview code{background:var(--bg3);padding:2px 6px;border-radius:4px;font-size:0.85rem}
.preview pre{background:var(--bg3);padding:16px;border-radius:8px;overflow-x:auto;margin:12px 0}
.preview blockquote{border-left:4px solid var(--primary);padding:8px 16px;margin:12px 0;background:rgba(99,102,241,.1)}
.preview ul,.preview ol{margin:8px 0 8px 24px}
.preview li{margin:4px 0;color:var(--text2)}
.preview strong{color:var(--text)}
.empty-state{flex:1;display:flex;align-items:center;justify-content:center;flex-direction:column;color:var(--text2);gap:16px}
.empty-state span{font-size:4rem}
.empty-state h2{font-size:1.5rem;color:var(--text)}
.empty-state p{max-width:400px;text-align:center;line-height:1.6}
.graph-view{flex:1;padding:24px;overflow-y:auto}
.graph-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:24px}
.stat-card{background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:24px;text-align:center}
.stat-card .label{font-size:0.85rem;color:var(--text2);margin-bottom:8px}
.stat-card .value{font-size:2.5rem;font-weight:700;color:var(--primary)}
.search-results{flex:1;padding:24px;overflow-y:auto}
.result-item{padding:16px;background:var(--bg2);border:1px solid var(--border);border-radius:8px;margin-bottom:12px;cursor:pointer;transition:all .2s}
.result-item:hover{border-color:var(--primary)}
.result-item h3{margin-bottom:6px}
.result-item p{color:var(--text2);font-size:0.9rem}
.modal-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:100}
.modal{background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:32px;width:90%;max-width:500px}
.modal h2{margin-bottom:16px}
.modal input,.modal textarea{width:100%;padding:10px;background:var(--bg3);border:1px solid var(--border);border-radius:6px;color:var(--text);margin-bottom:12px;font-size:0.9rem;outline:none}
.modal textarea{height:200px;font-family:monospace;resize:vertical}
.modal-actions{display:flex;gap:8px;justify-content:flex-end}
.modal-actions button{padding:10px 20px;border:none;border-radius:6px;cursor:pointer;font-weight:500}
.toast{position:fixed;bottom:24px;right:24px;padding:12px 24px;border-radius:8px;color:#fff;font-weight:500;z-index:200;animation:slideIn .3s ease}
.toast.success{background:var(--success)}
.toast.error{background:var(--error)}
@keyframes slideIn{from{transform:translateY(20px);opacity:0}to{transform:translateY(0);opacity:1}}
@media(max-width:768px){.sidebar{width:100%;position:fixed;z-index:50;transform:translateX(-100%);transition:transform .3s}.sidebar.open{transform:translateX(0)}.mobile-toggle{display:block!important}}
.mobile-toggle{display:none;position:fixed;top:12px;left:12px;z-index:60;background:var(--primary);color:#fff;border:none;padding:8px 12px;border-radius:8px;cursor:pointer;font-size:1.2rem}
.sidebar-footer{padding:12px 16px;border-top:1px solid var(--border);font-size:0.75rem;color:var(--text2)}
</style>
</head>
<body>
<button class="mobile-toggle" onclick="document.querySelector('.sidebar').classList.toggle('open')">&#9776;</button>
<div class="app">
<aside class="sidebar">
<div class="sidebar-header"><h1><span>&#128218;</span> Knowledge Vault</h1></div>
<div style="padding:0 16px">
<button class="new-btn" onclick="createNote()">+ New Note</button>
</div>
<div class="search-box"><input type="text" placeholder="Search notes..." oninput="searchNotes(this.value)"></div>
<nav class="nav">
<div class="nav-item active" onclick="switchView('notes',this)">&#128196; All Notes</div>
<div class="nav-item" onclick="switchView('graph',this)">&#128300; Knowledge Graph</div>
<div class="nav-item" onclick="switchView('search',this)">&#128269; Search</div>
</nav>
<div id="notesList" class="notes-list"></div>
<div class="sidebar-footer">Knowledge Vault v1.0 | <span id="noteCount">0</span> notes</div>
</aside>
<main class="main" id="mainContent">
<div class="empty-state" id="emptyState">
<span>&#128218;</span>
<h2>Welcome to Knowledge Vault</h2>
<p>Your personal knowledge management system. Create your first note to get started!</p>
<button class="new-btn" style="width:auto;padding:12px 32px" onclick="createNote()">+ Create First Note</button>
</div>
</main>
</div>
<script>
const API='/api';
let notes=[],currentNote=null,currentView='notes',guestId='guest-'+Math.random().toString(36).substr(2,9);

async function fetchNotes(){
  try{const r=await fetch(API+'/notes');const d=await r.json();notes=d.data||[];renderNotesList();document.getElementById('noteCount').textContent=notes.length}catch(e){console.error(e)}
}

function renderNotesList(){
  const el=document.getElementById('notesList');
  if(!notes.length){el.innerHTML='<p style="padding:16px;color:var(--text2);text-align:center;font-size:0.85rem">No notes yet</p>';return}
  el.innerHTML=notes.map(n=>'<div class="note-item'+(currentNote&&currentNote.id===n.id?' active':'')+'" onclick="openNote(\\''+n.id+'\\')"><h4>'+(n.title||'Untitled')+'</h4><p>'+(n.description||'No content')+'</p><time>'+new Date(n.created_at).toLocaleDateString()+'</time></div>').join('')
}

async function createNote(){
  try{
    const r=await fetch(API+'/notes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'Untitled Note',content:'',markdown:''})});
    const d=await r.json();
    if(d.data){await fetchNotes();openNote(d.data.id);showToast('Note created!','success')}
  }catch(e){showToast('Failed to create note','error')}
}

async function openNote(id){
  try{
    const r=await fetch(API+'/notes/'+id);const d=await r.json();
    if(d.data){currentNote=d.data;renderNotesList();renderEditor()}
  }catch(e){showToast('Failed to open note','error')}
}

function renderEditor(){
  if(!currentNote)return;
  const m=document.getElementById('mainContent');
  m.innerHTML=\`
<div class="toolbar">
<input id="noteTitle" value="\${currentNote.title||''}" placeholder="Note title..." onchange="autoSave()">
<button class="save-btn" onclick="saveNote()">&#128190; Save</button>
<button class="del-btn" onclick="deleteNote()">&#128465;</button>
</div>
<div class="tags-bar" id="tagsBar">
\${(currentNote.tags||[]).map(t=>'<span class="tag">'+t.name+'<button onclick="removeTag(this,\\''+t.name+'\\')">x</button></span>').join('')}
<input placeholder="Add tag + Enter" onkeydown="if(event.key==='Enter'){addTag(this.value);this.value=''}">
</div>
<div class="editor-area">
<div class="editor"><textarea id="noteContent" placeholder="Write in Markdown..." oninput="updatePreview()">\${currentNote.markdown||currentNote.content||''}</textarea></div>
<div class="preview" id="preview"></div>
</div>\`;
  updatePreview()
}

function updatePreview(){
  const c=document.getElementById('noteContent');if(!c)return;
  const t=c.value;
  document.getElementById('preview').innerHTML=t
    .replace(/^### (.+)$/gm,'<h3>$1</h3>')
    .replace(/^## (.+)$/gm,'<h2>$1</h2>')
    .replace(/^# (.+)$/gm,'<h1>$1</h1>')
    .replace(/\\*\\*(.+?)\\*\\*/g,'<strong>$1</strong>')
    .replace(/\\*(.+?)\\*/g,'<em>$1</em>')
    .replace(/\\\`\\\`\\\`([\\s\\S]*?)\\\`\\\`\\\`/g,'<pre><code>$1</code></pre>')
    .replace(/\\\`(.+?)\\\`/g,'<code>$1</code>')
    .replace(/^> (.+)$/gm,'<blockquote><p>$1</p></blockquote>')
    .replace(/^- (.+)$/gm,'<li>$1</li>')
    .replace(/(<li>.*<\\/li>)/s,'<ul>$1</ul>')
    .replace(/\\[\\[(.+?)\\]\\]/g,'<a href="#" style="color:var(--primary)">$1</a>')
    .replace(/\\n/g,'<br>')
}

async function saveNote(){
  if(!currentNote)return;
  const title=document.getElementById('noteTitle').value;
  const content=document.getElementById('noteContent').value;
  try{
    await fetch(API+'/notes/'+currentNote.id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({title,content,markdown:content})});
    currentNote.title=title;currentNote.content=content;
    await fetchNotes();showToast('Saved!','success')
  }catch(e){showToast('Failed to save','error')}
}

async function deleteNote(){
  if(!currentNote||!confirm('Delete this note?'))return;
  try{
    await fetch(API+'/notes/'+currentNote.id,{method:'DELETE'});
    currentNote=null;await fetchNotes();
    document.getElementById('mainContent').innerHTML='<div class="empty-state"><span>&#128218;</span><h2>Select or create a note</h2></div>';
    showToast('Note deleted','success')
  }catch(e){showToast('Failed to delete','error')}
}

async function searchNotes(q){
  if(!q){await fetchNotes();return}
  try{const r=await fetch(API+'/search?q='+encodeURIComponent(q));const d=await r.json();notes=d.data||[];renderNotesList()}catch(e){}
}

function switchView(view,el){
  currentView=view;
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  if(el)el.classList.add('active');
  const m=document.getElementById('mainContent');
  if(view==='notes'){currentNote=null;m.innerHTML='<div class="empty-state"><span>&#128218;</span><h2>Select or create a note</h2></div>'}
  else if(view==='graph'){renderGraph()}
  else if(view==='search'){renderSearchView()}
}

async function renderGraph(){
  const m=document.getElementById('mainContent');
  try{
    const r=await fetch(API+'/graph');const d=await r.json();const g=d.data||{nodes:[],edges:[]};
    m.innerHTML=\`<div class="graph-view"><h2 style="margin-bottom:24px">Knowledge Graph</h2>
    <div class="graph-stats">
    <div class="stat-card"><div class="label">Total Notes</div><div class="value">\${g.nodes.length}</div></div>
    <div class="stat-card"><div class="label">Connections</div><div class="value">\${g.edges.length}</div></div>
    <div class="stat-card"><div class="label">Density</div><div class="value">\${g.nodes.length>1?((g.edges.length/(g.nodes.length*(g.nodes.length-1)))*100).toFixed(1):0}%</div></div>
    </div>
    <div style="background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:24px">
    <p style="color:var(--text2)">Use <code>[[note name]]</code> syntax in your notes to create bidirectional links and build your knowledge network.</p>
    \${g.nodes.length?'<h3 style="margin:16px 0 12px">All Notes</h3>'+g.nodes.map(n=>'<div style="padding:8px 12px;background:var(--bg3);border-radius:6px;margin:4px 0;cursor:pointer" onclick="openNote(\\''+n.id+'\\');switchView(\\'notes\\')">'+n.label+'</div>').join(''):'<p style="margin-top:16px;color:var(--text2)">No notes yet. Create some to see your knowledge graph!</p>'}
    </div></div>\`
  }catch(e){m.innerHTML='<div class="empty-state"><p>Failed to load graph</p></div>'}
}

function renderSearchView(){
  const m=document.getElementById('mainContent');
  m.innerHTML=\`<div class="search-results"><h2 style="margin-bottom:16px">Search Notes</h2>
  <input type="text" placeholder="Type to search..." style="width:100%;padding:12px;background:var(--bg2);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:1rem;outline:none;margin-bottom:16px" oninput="doSearch(this.value)">
  <div id="searchResults"></div></div>\`
}

async function doSearch(q){
  const el=document.getElementById('searchResults');
  if(!q){el.innerHTML='<p style="color:var(--text2)">Type keywords to search your notes</p>';return}
  try{
    const r=await fetch(API+'/search?q='+encodeURIComponent(q));const d=await r.json();const results=d.data||[];
    el.innerHTML=results.length?results.map(n=>'<div class="result-item" onclick="openNote(\\''+n.id+'\\');switchView(\\'notes\\')"><h3>'+(n.title||'Untitled')+'</h3><p>'+(n.description||'')+'</p><time>'+new Date(n.created_at).toLocaleDateString()+'</time></div>').join(''):'<p style="color:var(--text2)">No results for "'+q+'"</p>'
  }catch(e){el.innerHTML='<p style="color:var(--error)">Search failed</p>'}
}

function addTag(name){if(!name||!currentNote)return;/* TODO: save tag */}
function removeTag(el,name){el.parentElement.remove()}

function showToast(msg,type){
  const t=document.createElement('div');t.className='toast '+type;t.textContent=msg;
  document.body.appendChild(t);setTimeout(()=>t.remove(),3000)
}

fetchNotes()
</script>
</body>
</html>`);
});

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
