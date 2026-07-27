// CURSE'M IDE — development entry point.
//
// §1: "Runs independently during development."
// This file is ONLY used for standalone dev (`npm run dev`).
// In production, Floyd Desktop imports CursemIDE from src/CursemIDE.tsx
// and mounts it inside its own route at /ide.

import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/global.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
