/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        void:    "#0A0A0B",
        surface: "#111113",
        elevated: "#18181B",
        "border-subtle":  "rgba(255,255,255,0.06)",
        "border-default": "rgba(255,255,255,0.09)",
        "border-strong":  "rgba(255,255,255,0.15)",
        accent: {
          DEFAULT: "#3B82F6",
          hover:   "#2563EB",
          muted:   "#1d3a6b",
          dim:     "rgba(59,130,246,0.08)",
        },
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ['"JetBrains Mono"', '"Fira Code"', "ui-monospace", "monospace"],
      },
      animation: {
        "slide-in-right": "slideInRight 0.22s ease-out",
        "fade-in":        "fadeIn 0.2s ease-out",
        "row-in":         "rowIn 0.18s ease-out both",
      },
      keyframes: {
        slideInRight: {
          "0%":   { transform: "translateX(100%)", opacity: "0" },
          "100%": { transform: "translateX(0)",    opacity: "1" },
        },
        fadeIn: {
          "0%":   { opacity: "0" },
          "100%": { opacity: "1" },
        },
        rowIn: {
          "0%":   { opacity: "0", transform: "translateY(5px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
    },
  },
  plugins: [],
};
