import {defineConfig} from 'vite';import path from 'node:path';import {fileURLToPath} from 'node:url';
const directory=path.dirname(fileURLToPath(import.meta.url));
/** Code-only private child artifact; never part of hosted/public downloads. */
export default defineConfig({envDir:false,build:{target:'node24',outDir:path.join(directory,'dist-closed-native'),emptyOutDir:false,minify:false,
 lib:{entry:path.join(directory,'closed-native-child.ts'),formats:['es'],fileName:()=> 'closed-native-child.mjs'},
 rollupOptions:{external:(id:string)=>id.startsWith('node:')}}});
