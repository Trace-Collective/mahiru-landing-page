# DGMAHIRU Landing Page

DGMAHIRU is a cinematic landing page for an autonomous perpetual futures trading agent. The site uses a panoramic animated background with scroll-driven camera movement, floating glassmorphism panels, and a retro-futuristic visual treatment inspired by a neon-lit trading room.

## Highlights

- 400vh sticky scroll scene with horizontal camera pan tied to scroll progress
- Looping panoramic background video with runtime sizing and playback fallback
- Three narrative stops:
  - Hero near the city window
  - Animated backtest metrics at the trading desk
  - Strategy and roadmap module near the bookshelf
- Responsive overlay system tuned for desktop and mobile
- Production-ready single-page frontend built at the repo root

## Stack

- Vite
- React
- Plain CSS

## Development

```bash
npm install
npm run dev
```

Build for production:

```bash
npm run build
```

Preview the production build locally:

```bash
npm run preview
```

## Project Structure

```text
.
├── public/
│   └── media/
│       └── dg-mahiru-room-loop.mp4
├── src/
│   ├── App.jsx
│   ├── main.jsx
│   └── styles.css
├── index.html
├── package.json
├── vite.config.mjs
└── README.md
```

## Notes

- The landing page lives at the repo root.
- The current CTA is intentionally a placeholder pending the leaderboard destination.
