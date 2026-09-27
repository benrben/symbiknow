import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './app.css';
import './brand-theme.css';
import { applyTheme, preferredTheme } from './theme';

applyTheme(preferredTheme());
createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>,
);
