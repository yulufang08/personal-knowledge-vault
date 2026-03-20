import React, { useEffect, useState } from 'react'
import axios from 'axios'
import '../styles/GraphView.css'

interface GraphData {
  nodes: Array<{ id: string; label: string }>
  edges: Array<{ from: string; to: string }>
}

export default function GraphView() {
  const [graphData, setGraphData] = useState<GraphData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchGraphData()
  }, [])

  const fetchGraphData = async () => {
    try {
      const response = await axios.get('/api/graph')
      setGraphData(response.data.data)
    } catch (error) {
      console.error('Failed to fetch graph data:', error)
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return <div className="graph-view loading">Loading knowledge graph...</div>
  }

  if (!graphData || graphData.nodes.length === 0) {
    return (
      <div className="graph-view empty">
        <p>No knowledge graph data yet. Create and link notes to build your knowledge network!</p>
      </div>
    )
  }

  return (
    <div className="graph-view">
      <div className="graph-header">
        <h2>Knowledge Graph</h2>
        <p>{graphData.nodes.length} notes connected by {graphData.edges.length} links</p>
      </div>

      <div className="graph-info">
        <p>Knowledge graph visualization will show your notes and their relationships.</p>
        <p>Use [[note-name]] syntax in your notes to create bidirectional links.</p>
      </div>

      <div className="graph-stats">
        <div className="stat">
          <span className="stat-label">Total Notes</span>
          <span className="stat-value">{graphData.nodes.length}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Connections</span>
          <span className="stat-value">{graphData.edges.length}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Density</span>
          <span className="stat-value">
            {graphData.nodes.length > 0
              ? ((graphData.edges.length / (graphData.nodes.length * (graphData.nodes.length - 1))) * 100).toFixed(1)
              : 0}%
          </span>
        </div>
      </div>
    </div>
  )
}
