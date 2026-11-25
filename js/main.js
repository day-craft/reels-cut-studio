import { createApp } from './ui/app.js';

const app = createApp({ doc: document, win: window });

// Handy when debugging on the iPhone: 릴스컷.state.clips
window.릴스컷 = app;
window.reelsCut = app;
