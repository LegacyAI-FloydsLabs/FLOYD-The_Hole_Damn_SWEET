/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // CRUSH Theme - Backgrounds (using CSS variables for dynamic switching)
        'crush-base': 'var(--color-bg-base, #000000)',
        'crush-elevated': 'var(--color-bg-elevated, #050505)',
        'crush-overlay': 'var(--color-bg-overlay, #0A0A0A)',
        'crush-modal': 'var(--color-bg-modal, #111111)',

        // CRUSH Theme - Text (using CSS variables)
        'crush-text-primary': 'var(--color-text-primary, #FFFFFF)',
        'crush-text-secondary': 'var(--color-text-secondary, #CCCCCC)',
        'crush-text-tertiary': 'var(--color-text-tertiary, #888888)',
        'crush-text-subtle': 'var(--color-text-subtle, #444444)',
        'crush-text-selected': 'var(--color-text-selected, #FFFFFF)',
        'crush-text-inverse': 'var(--color-text-inverse, #000000)',

        // CRUSH Theme - Accents (using CSS variables)
        'crush-primary': 'var(--color-accent-primary, #2E95D3)',
        'crush-secondary': 'var(--color-accent-secondary, #00C2FF)',
        'crush-tertiary': 'var(--color-accent-tertiary, #00E5FF)',
        'crush-highlight': 'var(--color-accent-highlight, #FFFFFF)',
        'crush-info': 'var(--color-accent-info, #2E95D3)',

        // CRUSH Theme - Status (using CSS variables)
        'crush-ready': 'var(--color-status-ready, #00C2FF)',
        'crush-working': 'var(--color-status-working, #2E95D3)',
        'crush-warning': 'var(--color-status-warning, #FFCC00)',
        'crush-error': 'var(--color-status-error, #FF4444)',
        'crush-blocked': 'var(--color-status-blocked, #444444)',
        'crush-online': 'var(--color-status-ready, #00C2FF)',
        'crush-offline': 'var(--color-status-offline, #222222)',
        'crush-busy': 'var(--color-status-busy, #00E5FF)',

        // CRUSH Theme - Extended Colors (31 colors)
        'crush-coral': 'var(--color-extended-coral, #FFFFFF)',
        'crush-salmon': 'var(--color-extended-salmon, #E0E0E0)',
        'crush-cherry': 'var(--color-extended-cherry, #00C2FF)',
        'crush-sriracha': 'var(--color-extended-sriracha, #FF4444)',
        'crush-chili': 'var(--color-extended-chili, #FFFFFF)',
        'crush-bengal': 'var(--color-extended-bengal, #FFCC00)',
        'crush-blush': 'var(--color-extended-blush, #FFFFFF)',
        'crush-violet': 'var(--color-extended-violet, #2E95D3)',
        'crush-mauve': 'var(--color-extended-mauve, #00C2FF)',
        'crush-grape': 'var(--color-extended-grape, #00E5FF)',
        'crush-plum': 'var(--color-extended-plum, #2E95D3)',
        'crush-orchid': 'var(--color-extended-orchid, #00C2FF)',
        'crush-jelly': 'var(--color-extended-jelly, #0A0A0A)',
        'crush-hazy': 'var(--color-extended-hazy, #2E95D3)',
        'crush-prince': 'var(--color-extended-prince, #FFFFFF)',
        'crush-urchin': 'var(--color-extended-urchin, #00C2FF)',
        'crush-malibu': 'var(--color-extended-malibu, #2E95D3)',
        'crush-sardine': 'var(--color-extended-sardine, #00C2FF)',
        'crush-damson': 'var(--color-extended-damson, #007AB8)',
        'crush-thunder': 'var(--color-extended-thunder, #4776FF)',
        'crush-anchovy': 'var(--color-extended-anchovy, #719AFC)',
        'crush-sapphire': 'var(--color-extended-sapphire, #4949FF)',
        'crush-guppy': 'var(--color-extended-guppy, #7272FF)',
        'crush-oceania': 'var(--color-extended-oceania, #2B55B3)',
        'crush-ox': 'var(--color-extended-ox, #3331B2)',
        'crush-guac': 'var(--color-extended-guac, #12C78F)',
        'crush-julep': 'var(--color-extended-julep, #00FFB2)',
        'crush-pickle': 'var(--color-extended-pickle, #00A475)',
        'crush-gator': 'var(--color-extended-gator, #18463D)',
        'crush-spinach': 'var(--color-extended-spinach, #1C3634)',
        'crush-citron': 'var(--color-extended-citron, #E8FF27)',
        'crush-cumin': 'var(--color-extended-cumin, #BF976F)',
        'crush-tang': 'var(--color-extended-tang, #FF985A)',
        'crush-yam': 'var(--color-extended-yam, #FFB587)',
        'crush-paprika': 'var(--color-extended-paprika, #D36C64)',
        'crush-uni': 'var(--color-extended-uni, #FF937D)',

        // CRUSH Theme - Role Colors (9 roles)
        'crush-role-header-title': 'var(--color-role-headerTitle, #00C2FF)',
        'crush-role-header-status': 'var(--color-role-headerStatus, #FFFFFF)',
        'crush-role-user-label': 'var(--color-role-userLabel, #FFFFFF)',
        'crush-role-assistant-label': 'var(--color-role-assistantLabel, #2E95D3)',
        'crush-role-system-label': 'var(--color-role-systemLabel, #444444)',
        'crush-role-tool-label': 'var(--color-role-toolLabel, #00E5FF)',
        'crush-role-thinking': 'var(--color-role-thinking, #2E95D3)',
        'crush-role-input-prompt': 'var(--color-role-inputPrompt, #00C2FF)',
        'crush-role-hint': 'var(--color-role-hint, #666666)',

        // CRUSH Theme - Syntax Colors (8 tokens)
        'crush-syntax-keywords': 'var(--color-syntax-keywords, #00C2FF)',
        'crush-syntax-functions': 'var(--color-syntax-functions, #FFFFFF)',
        'crush-syntax-strings': 'var(--color-syntax-strings, #2E95D3)',
        'crush-syntax-numbers': 'var(--color-syntax-numbers, #00E5FF)',
        'crush-syntax-comments': 'var(--color-syntax-comments, #444444)',
        'crush-syntax-classes': 'var(--color-syntax-classes, #FFFFFF)',
        'crush-syntax-operators': 'var(--color-syntax-operators, #FFFFFF)',
        'crush-syntax-punctuation': 'var(--color-syntax-punctuation, #666666)',

        // CRUSH Theme - Diff Colors (6 tokens)
        'crush-diff-add-line-number': 'var(--color-diff-addition-line-number, #2E95D3)',
        'crush-diff-add-symbol': 'var(--color-diff-addition-symbol, #2E95D3)',
        'crush-diff-add-background': 'var(--color-diff-addition-background, #001122)',
        'crush-diff-del-line-number': 'var(--color-diff-deletion-line-number, #444444)',
        'crush-diff-del-symbol': 'var(--color-diff-deletion-symbol, #444444)',
        'crush-diff-del-background': 'var(--color-diff-deletion-background, #111111)',
      },
    },
  },
  plugins: [],
}
