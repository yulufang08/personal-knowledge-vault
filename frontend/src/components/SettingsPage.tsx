import React, { useState } from 'react'
import '../styles/SettingsPage.css'

export default function SettingsPage() {
  const [autoSave, setAutoSave] = useState(true)
  const [darkMode, setDarkMode] = useState(false)
  const [notifications, setNotifications] = useState(true)

  const handleExport = async () => {
    try {
      const response = await fetch('/api/export')
      const blob = await response.blob()
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'knowledge-vault-export.json'
      document.body.appendChild(a)
      a.click()
      window.URL.revokeObjectURL(url)
      document.body.removeChild(a)
    } catch (error) {
      console.error('Export failed:', error)
    }
  }

  return (
    <div className="settings-page">
      <div className="settings-header">
        <h2>Settings</h2>
        <p>Configure your Knowledge Vault preferences</p>
      </div>

      <div className="settings-section">
        <h3>Preferences</h3>
        <div className="setting-item">
          <div className="setting-info">
            <label>Auto-save</label>
            <p>Automatically save notes as you type</p>
          </div>
          <input
            type="checkbox"
            checked={autoSave}
            onChange={(e) => setAutoSave(e.target.checked)}
          />
        </div>

        <div className="setting-item">
          <div className="setting-info">
            <label>Dark Mode</label>
            <p>Enable dark theme</p>
          </div>
          <input
            type="checkbox"
            checked={darkMode}
            onChange={(e) => setDarkMode(e.target.checked)}
          />
        </div>

        <div className="setting-item">
          <div className="setting-info">
            <label>Notifications</label>
            <p>Enable in-app notifications</p>
          </div>
          <input
            type="checkbox"
            checked={notifications}
            onChange={(e) => setNotifications(e.target.checked)}
          />
        </div>
      </div>

      <div className="settings-section">
        <h3>Data Management</h3>
        <button className="action-btn export-btn" onClick={handleExport}>
          📥 Export All Notes
        </button>
        <p className="setting-description">
          Download all your notes as a JSON file for backup or migration.
        </p>
      </div>

      <div className="settings-section">
        <h3>About</h3>
        <div className="about-info">
          <p><strong>Knowledge Vault</strong></p>
          <p>Version: 1.0.0</p>
          <p>A personal knowledge management system for organizing your thoughts and notes.</p>
          <p>Built with React, TypeScript, and Node.js</p>
        </div>
      </div>
    </div>
  )
}
