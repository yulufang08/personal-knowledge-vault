import React, { useEffect, useState } from 'react'
import { useNotesStore } from '../store/notesStore'
import { Note } from '../store/notesStore'
import '../styles/SearchPage.css'

interface SearchPageProps {
  query: string
}

export default function SearchPage({ query }: SearchPageProps) {
  const { search } = useNotesStore()
  const [results, setResults] = useState<Note[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (query) {
      setLoading(true)
      search(query).then(res => {
        setResults(res)
        setLoading(false)
      })
    }
  }, [query, search])

  return (
    <div className="search-page">
      <div className="search-header">
        <h2>Search Results</h2>
        <p>Search for: <strong>{query}</strong></p>
        <p className="result-count">{results.length} results found</p>
      </div>

      {loading && <p className="loading">Searching...</p>}

      {!loading && results.length === 0 && (
        <div className="empty-state">
          <p>No results found for "{query}"</p>
        </div>
      )}

      <div className="search-results">
        {results.map(note => (
          <div key={note.id} className="search-result-item">
            <h3>{note.title}</h3>
            <p className="result-preview">{note.description || note.content?.substring(0, 150)}</p>
            <time>{new Date(note.created_at).toLocaleDateString()}</time>
          </div>
        ))}
      </div>
    </div>
  )
}
