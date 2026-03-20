import React, { useState, useEffect } from 'react'
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom'
import Sidebar from './components/Sidebar'
import NotesList from './components/NotesList'
import NoteEditor from './components/NoteEditor'
import SearchPage from './components/SearchPage'
import GraphView from './components/GraphView'
import SettingsPage from './components/SettingsPage'
import { useNotesStore } from './store/notesStore'
import './App.css'

function App() {
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [currentView, setCurrentView] = useState<'list' | 'editor' | 'search' | 'graph' | 'settings'>('list')
  const { notes, fetchNotes, loading } = useNotesStore()

  useEffect(() => {
    fetchNotes()
  }, [fetchNotes])

  return (
    <Router>
      <div className="app-container">
        <Sidebar
          onViewChange={setCurrentView}
          currentView={currentView}
          onSearch={setSearchQuery}
        />
        <main className="main-content">
          <Routes>
            <Route path="/" element={
              <>
                {currentView === 'list' && (
                  <NotesList
                    notes={notes}
                    loading={loading}
                    onSelectNote={(id) => {
                      setSelectedNoteId(id)
                      setCurrentView('editor')
                    }}
                  />
                )}
                {currentView === 'editor' && selectedNoteId && (
                  <NoteEditor noteId={selectedNoteId} />
                )}
                {currentView === 'search' && (
                  <SearchPage query={searchQuery} />
                )}
                {currentView === 'graph' && (
                  <GraphView />
                )}
                {currentView === 'settings' && (
                  <SettingsPage />
                )}
              </>
            } />
          </Routes>
        </main>
      </div>
    </Router>
  )
}

export default App
