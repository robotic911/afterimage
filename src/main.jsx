import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'

const windowType = new URLSearchParams(window.location.search).get('window')
const App = lazy(() => import('./App.jsx'))
const TodayMonitor = lazy(() => import('./components/monitor/TodayMonitor.jsx'))

export function Root() {
  const Component = windowType === 'today-monitor' ? TodayMonitor : App
  return (
    <Suspense fallback={null}>
      <Component />
    </Suspense>
  )
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
