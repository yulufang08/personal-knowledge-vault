import { create } from 'zustand'
import axios from 'axios'

export interface Note {
  id: string
  title: string
  content: string
  markdown: string
  description?: string
  created_at: string
  updated_at: string
  tags?: any[]
  links?: any[]
}

interface NotesStore {
  notes: Note[]
  currentNote: Note | null
  tags: any[]
  loading: boolean
  error: string | null
  fetchNotes: () => Promise<void>
  fetchNote: (id: string) => Promise<Note | null>
  createNote: (title: string, content: string) => Promise<Note | null>
  updateNote: (id: string, title: string, content: string, markdown: string, tags?: string[]) => Promise<Note | null>
  deleteNote: (id: string) => Promise<void>
  fetchTags: () => Promise<void>
  search: (query: string) => Promise<Note[]>
}

const API_URL = '/api'

export const useNotesStore = create<NotesStore>((set, get) => ({
  notes: [],
  currentNote: null,
  tags: [],
  loading: false,
  error: null,

  fetchNotes: async () => {
    set({ loading: true, error: null })
    try {
      const response = await axios.get(`${API_URL}/notes`)
      set({ notes: response.data.data, loading: false })
    } catch (error: any) {
      set({ error: error.message, loading: false })
    }
  },

  fetchNote: async (id: string) => {
    set({ loading: true, error: null })
    try {
      const response = await axios.get(`${API_URL}/notes/${id}`)
      const note = response.data.data
      set({ currentNote: note, loading: false })
      return note
    } catch (error: any) {
      set({ error: error.message, loading: false })
      return null
    }
  },

  createNote: async (title: string, content: string) => {
    try {
      const response = await axios.post(`${API_URL}/notes`, {
        title,
        content,
        markdown: content
      })
      const newNote = response.data.data
      set(state => ({
        notes: [newNote, ...state.notes]
      }))
      return newNote
    } catch (error: any) {
      set({ error: error.message })
      return null
    }
  },

  updateNote: async (id: string, title: string, content: string, markdown: string, tags?: string[]) => {
    try {
      const response = await axios.put(`${API_URL}/notes/${id}`, {
        title,
        content,
        markdown,
        tags
      })
      const updatedNote = response.data.data
      set(state => ({
        notes: state.notes.map(n => n.id === id ? { ...n, ...updatedNote } : n),
        currentNote: state.currentNote?.id === id ? { ...state.currentNote, ...updatedNote } : state.currentNote
      }))
      return updatedNote
    } catch (error: any) {
      set({ error: error.message })
      return null
    }
  },

  deleteNote: async (id: string) => {
    try {
      await axios.delete(`${API_URL}/notes/${id}`)
      set(state => ({
        notes: state.notes.filter(n => n.id !== id),
        currentNote: state.currentNote?.id === id ? null : state.currentNote
      }))
    } catch (error: any) {
      set({ error: error.message })
    }
  },

  fetchTags: async () => {
    try {
      const response = await axios.get(`${API_URL}/tags`)
      set({ tags: response.data.data })
    } catch (error: any) {
      set({ error: error.message })
    }
  },

  search: async (query: string) => {
    try {
      const response = await axios.get(`${API_URL}/search`, {
        params: { q: query }
      })
      return response.data.data
    } catch (error) {
      return []
    }
  }
}))
