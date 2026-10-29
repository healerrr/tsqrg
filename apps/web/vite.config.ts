import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
export default defineConfig({
  plugins:[vue()],
  build:{
    target:'es2022',
    rollupOptions:{output:{manualChunks(id){
      if(id.includes('/node_modules/pixi.js/'))return 'pixi';
      if(id.includes('/node_modules/lucide-vue-next/'))return 'icons';
      if(id.includes('/node_modules/socket.io-client/')||id.includes('/node_modules/engine.io-client/'))return 'realtime';
      if(id.includes('/node_modules/vue/')||id.includes('/node_modules/@vue/')||id.includes('/node_modules/pinia/'))return 'vue';
    }}},
  },
  server:{host:'127.0.0.1',port:5173,proxy:{'/api':'http://127.0.0.1:3000','/socket.io':{target:'http://127.0.0.1:3000',ws:true},'/uploads':'http://127.0.0.1:3000'}},
});
