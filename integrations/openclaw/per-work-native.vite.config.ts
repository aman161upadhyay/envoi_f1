import {defineConfig} from 'vite';import path from 'node:path';import {fileURLToPath} from 'node:url';
const directory=path.dirname(fileURLToPath(import.meta.url));
export default defineConfig({envDir:false,build:{target:'node24',outDir:path.join(directory,'dist-closed-native'),emptyOutDir:false,minify:false,
 lib:{entry:path.join(directory,'per-work-native.ts'),formats:['es'],fileName:()=> 'per-work-native.mjs'},rollupOptions:{external:(id:string)=>id.startsWith('node:')}}});
