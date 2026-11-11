import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/commissioner';
import '@fontsource/instrument-serif/latin-400.css';
import '@fontsource-variable/instrument-sans/wght.css';
import '@fontsource-variable/newsreader/wght.css';
import '@fontsource/geist-mono/latin-400.css';
import App from './App';
import { initAnalytics } from './analytics';
import './styles/tokens.css';
import './styles/app.css';
import './styles/envoi-app.css';
import './styles/landing.css';
import './onboarding/connect.css';
import './onboarding/claim.css';
import './styles/product-brand.css';
import './styles/chat-lux.css';

initAnalytics();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>
);
