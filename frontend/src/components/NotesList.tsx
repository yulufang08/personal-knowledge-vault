import React from 'react'
import { Note } from '../store/notesStore'
import '../styles/NotesList.css'

interface NotesListProps {
  notes: Note[]
  loading: boolean
  onSelectNote: (id: string) => void
}

export default function NotesList({ notes, loading, onSelectNote }: NotesListProps) {
  if (loading) {
    return <div className="notes-list loading">Loading notes...</div>
  }

  return (
    <div className="notes-list">
      <div className="notes-header">
        <h2>My Notes</h2>
        <p className="notes-count">{notes.length} notes</p>
      </div>

      {notes.length === 0 ? (
        <div className="empty-state">
          <p>No notes yet. Create your first note to get started!</p>
        </div>
      ) : (
        <div className="notes-grid">
          {notes.map(note => (
            <div
              key={note.id}
              className="note-card"
              onClick={() => onSelectNote(note.id)}
            >
              <h3>{note.title || 'Untitled'}</h3>
              <p className="note-preview">
                {note.description || note.content?.substring(0, 100) || 'No content'}
              </p>
              <div className="note-meta">
                <time>{new Date(note.created_at).toLocaleDateString()}</time>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
