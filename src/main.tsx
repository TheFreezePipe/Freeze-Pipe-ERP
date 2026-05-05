import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { initObservability } from '@/lib/observability'

// Bootstrap Sentry (prod-only, dynamic-imported) before the React tree
// mounts so it catches errors during initial render. No-op in dev /
// staging / when VITE_SENTRY_DSN is not set; safe to call unconditionally.
initObservability();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
