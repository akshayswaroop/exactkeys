import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { youtubeAudioPlugin } from './vite.youtube';

export default defineConfig({
  plugins: [react(), youtubeAudioPlugin()],
});
