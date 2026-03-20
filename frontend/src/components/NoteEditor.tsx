import React, { useState, useEffect } from 'react'
import { useNotesStore } from '../store/notesStore'
import { FiSave, FiTrash2 } from 'react-icons/fi'
import '../styles/NoteEditor.css'

interface NoteEditorProps {
  noteId: string
}

export default function NoteEditor({ noteId }: NoteEditorProps) {
  const { currentNote, fetchNote, updateNote, deleteNote } = useNotesStore()
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    fetchNote(noteId).then(note => {
      if (note) {
        setTitle(note.title)
        setContent(note.markdown || note.content)
        setTags(note.tags?.map(t => t.name) || [])
      }
    })
  }, [noteId, fetchNote])

  const handleSave = async () => {
    setIsSaving(true)
    await updateNote(noteId, title, content, content, tags)
    setIsSaving(false)
  }

  const handleDelete = async () => {
    if (window.confirm('Are you sure you want to delete this note?')) {
      await deleteNote(noteId)
    }
  }

  const handleAddTag = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && e.currentTarget.value) {
      setTags([...tags, e.currentTarget.value])
      e.currentTarget.value = ''
    }
  }

  const removeTag = (index: number) => {
    setTags(tags.filter((_, i) => i !== index))
  }

  return (
    <div className="note-editor">
      <div className="editor-header">
        <input
          type="text"
          placeholder="Note title..."
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="title-input"
        />
        <div className="editor-actions">
          <button
            className="save-btn"
            onClick={handleSave}
            disabled={isSaving}
          >
            <FiSave size={18} /> {isSaving ? 'Saving...' : 'Save'}
          </button>
          <button
            className="delete-btn"
            onClick={handleDelete}
            title="Delete note"
          >
            <FiTrash2 size={18} />
          </button>
        </div>
      </div>

      <div className="editor-tags">
        <div className="tags-list">
          {tags.map((tag, i) => (
            <span key={i} className="tag-item">
              {tag}
              <button onClick={() => removeTag(i)}>×</button>
            </span>
          ))}
        </div>
        <input
          type="text"
          placeholder="Add tag and press Enter..."
          className="tag-input"
          onKeyDown={handleAddTag}
        />
      </div>

      <textarea
        className="markdown-editor"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="Write your note in Markdown..."
        spellCheck="false"
      />

      <div className="editor-preview">
        <h3>Preview</h3>
        <div
          className="markdown-content"
          dangerouslySetInnerHTML={{
            __html: content
              .replace(/^# (.+)$/gm, '<h1>$1</h1>')
              .replace(/^## (.+)$/gm, '<h2>$1</h2>')
              .replace(/^### (.+)$/gm, '<h3>$1</h3>')
              .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
              .replace(/\*(.+?)\*/g, '<em>$1</em>')
              .replace(/\n/g, '<br/>')
          }}
        />
      </div>
    </div>
  )
}
