import fs from 'node:fs/promises';import path from 'node:path';import {createHash} from 'node:crypto';
/** Complete materialized code-copy digest; the generated root manifest excludes itself. */
export async function nativeCodeTreeDigest(root:string){const files:string[]=[];
 const visit=async(dir:string)=>{for(const entry of await fs.readdir(dir,{withFileTypes:true})){const file=path.join(dir,entry.name),relative=path.relative(root,file).replaceAll('\\','/');
  if(relative==='envoi-native-source-copy.json')continue;if(entry.isSymbolicLink())throw Error('MATERIALIZED_NATIVE_CODE_COPY_REQUIRED');if(entry.isDirectory())await visit(file);else if(entry.isFile())files.push(relative);else throw Error('NATIVE_CODE_FILE_TYPE_REFUSED');}};
 await visit(root);files.sort();const entries:Array<[string,string]>=[];
 for(let index=0;index<files.length;index+=16)entries.push(...await Promise.all(files.slice(index,index+16).map(async name=>[name,createHash('sha256').update(await fs.readFile(path.join(root,name))).digest('hex')]as[string,string])));
 return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}
