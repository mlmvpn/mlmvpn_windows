module.exports = {
  content: ["./public/**/*.{html,js}"],
  theme: {
    fontFamily: {
      sans: ['Vazirmatn', 'IRANSansX', 'sans-serif'],
      mono: ['"Fira Code"', 'Consolas', 'monospace']
    },
    extend: {
      colors: {
        gs: {
          bg: 'var(--ide-bg)',
          panel: 'var(--ide-panel)',
          surface: 'var(--ide-sidebar)',
          border: 'var(--ide-border)',
          text: 'var(--ide-text-main)',
          muted: 'var(--ide-text-muted)',
          primary: 'var(--syn-blue)',
          success: 'var(--syn-green)',
          danger: 'var(--syn-red)',
          warning: 'var(--syn-yellow)'
        },
        m3: {
          bg: 'var(--ide-bg)',
          surface: 'var(--ide-panel)',
          surface2: 'var(--ide-sidebar)',
          surface3: 'var(--ide-border)',
          surfaceHover: 'var(--ide-sidebar)',
          surfaceActive: 'var(--syn-blue)',
          primary: 'var(--syn-blue)',
          onPrimary: 'var(--ide-bg)',
          onSurface: 'var(--ide-text-main)',
          onSurfaceVariant: 'var(--ide-text-dim)',
          secondary: 'var(--ide-text-muted)',
          outline: 'var(--ide-border)',
          error: 'var(--syn-red)',
          success: 'var(--syn-green)'
        }
      }
    }
  }
}
