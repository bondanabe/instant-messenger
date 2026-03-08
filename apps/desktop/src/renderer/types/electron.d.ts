// Extend React.CSSProperties untuk mendukung Electron-specific CSS property
import 'react'

declare module 'react' {
  interface CSSProperties {
    // Electron drag region: set ke 'drag' untuk title bar dragging
    WebkitAppRegion?: 'drag' | 'no-drag' | 'none'
  }
}
