import React, { useState } from 'react'
import { FiPlus, FiSearch, FiType, FiZap, FiSettings, FiBook } from 'react-icons/fi'
import { useNotesStore } from '../store/notesStore'
import '../styles/Sidebar.css'

interface SidebarProps {
  onViewChange: (view: 'list' | 'editor' | 'search' | 'graph' | 'settings') => void
  currentView: string
  onSearch: (query: string) => void
}

export default function Sidebar({ onViewChange, currentView, onSearch }: SidebarProps) {
  const [searchInput, setSearchInput] = useState('')
  const { createNote } = useNotesStore()

  const handleNewNote = async () => {
    const note = await createNote('Untitled', '')
    if (note) {
      onViewChange('editor')
    }
  }

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault()
    onSearch(searchInput)
    onViewChange('search')
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="logo">
          <FiBook size={24} />
          <h1>Knowledge Vault</h1>
        </div>
      </div>

      <button className="new-note-btn" onClick={handleNewNote}>
        <FiPlus size={20} /> New Note
      </button>

      <form className="search-form" onSubmit={handleSearch}>
        <input
          type="text"
          placeholder="Search notes..."
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          className="search-input"
        />
        <button type="submit" className="search-btn">
          <FiSearch size={18} />
        </button>
      </form>

      <nav className="sidebar-nav">
        <button
          className={`nav-item ${currentView === 'list' ? 'active' : ''}`}
          onClick={() => onViewChange('list')}
          title="All Notes"
        >
          <FiType size={20} />
          <span>All Notes</span>
        </button>

        <button
          className={`nav-item ${currentView === 'graph' ? 'active' : ''}`}
          onClick={() => onViewChange('graph')}
          title="Knowledge Graph"
        >
          <FiZap size={20} />
          <span>Graph</span>
        </button>

        <button
          className={`nav-item ${currentView === 'settings' ? 'active' : ''}`}
          onClick={() => onViewChange('settings')}
          title="Settings"
        >
          <FiSettings size={20} />
          <span>Settings</span>
        </button>
      </nav>

      <div className="sidebar-footer">
        <p className="version">v1.0.0</p>
      </div>
    </aside>
  )
}
