/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        void: "#080808",
        surface: "#111111",
        elevated: "#1a1a1a",
        "border-subtle": "#1e1e1e",
        "border-default": "#2a2a2a",
        "border-strong": "#3a3a3a",
        accent: {
          DEFAULT: "#8b5cf6",
          hover: "#7c3aed",
          muted: "#2d1b69",
          dim: "rgba(139,92,246,0.15)",
        },
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ['"JetBrains Mono"', '"Fira Code"', "ui-monospace", "monospace"],
      },
      animation: {
        "slide-in-right": "slideInRight 0.25s ease-out",
        "fade-in": "fadeIn 0.2s ease-out",
        "row-in": "rowIn 0.18s ease-out both",
      },
      keyframes: {
        slideInRight: {
          "0%": { transform: "translateX(100%)", opacity: "0" },
          "100%": { transform: "translateX(0)", opacity: "1" },
        },
        fadeIn: {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        rowIn: {
          "0%": { opacity: "0", transform: "translateY(6px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
    },
  },
  plugins: [],
};
