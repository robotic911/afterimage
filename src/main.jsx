import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import TodayMonitor from './components/monitor/TodayMonitor.jsx'

const windowType = new URLSearchParams(window.location.search).get('window')

export function Root() {
  return windowType === 'today-monitor' ? <TodayMonitor /> : <App />
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
